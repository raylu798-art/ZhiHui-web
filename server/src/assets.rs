use crate::{
    auth::Auth,
    crypto,
    error::{ApiError, Result},
    models::{self, Asset},
    state::App,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

struct Partial(std::path::PathBuf);
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub async fn usage(state: &App, uid: &str) -> Result<u64> {
    state.user_db(uid).await?;
    let dir = state.config.data_dir.join("users").join(uid);
    let mut size = 0;
    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let meta = entry.metadata().await?;
        if meta.is_file() {
            size += meta.len();
        } else if entry.file_name() == "assets" {
            let mut files = tokio::fs::read_dir(entry.path()).await?;
            while let Some(file) = files.next_entry().await? {
                let meta = file.metadata().await?;
                if meta.is_file() {
                    size += meta.len();
                }
            }
        }
    }
    Ok(size)
}
pub struct AudioInfo {
    pub duration: f64,
    pub channels: u64,
    pub sample_rate: u64,
}
pub async fn probe(state: &App, path: &std::path::Path) -> Result<f64> {
    Ok(probe_info(state, path).await?.duration)
}
pub async fn probe_info(state: &App, path: &std::path::Path) -> Result<AudioInfo> {
    let child = tokio::process::Command::new(&state.config.ffprobe)
        .args([
            "-v",
            "error",
            "-max_alloc",
            "67108864",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "wav,mp3,mov,flac,ogg,matroska,webm,aac",
            "-show_entries",
            "format=duration:stream=codec_type,channels,sample_rate",
            "-of",
            "json",
        ])
        .arg(path)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child)
        .await
        .map_err(|_| ApiError::bad("音频文件检查超时"))?
        .map_err(|_| ApiError::bad("服务器缺少音频检查工具 ffprobe，请联系管理员"))?;
    let result: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| ApiError::bad("无法读取音频文件"))?;
    if !output.status.success()
        || !result["streams"]
            .as_array()
            .is_some_and(|s| s.iter().any(|s| s["codec_type"] == "audio"))
    {
        return Err(ApiError::bad("文件中没有可识别的音轨"));
    }
    let duration = result["format"]["duration"]
        .as_str()
        .and_then(|x| x.parse::<f64>().ok())
        .ok_or_else(|| ApiError::bad("无法确认音频时长"))?;
    if !duration.is_finite() || duration <= 0.0 || duration > state.config.max_seconds as f64 {
        return Err(ApiError::bad("音频时长无效或超过时长限制"));
    }
    let stream = result["streams"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["codec_type"] == "audio"))
        .ok_or_else(|| ApiError::bad("文件中没有音轨"))?;
    Ok(AudioInfo {
        duration,
        channels: stream["channels"].as_u64().unwrap_or(0),
        sample_rate: stream["sample_rate"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
    })
}
fn mime(name: &str) -> Result<&'static str> {
    let extension = std::path::Path::new(name)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "wav" => Ok("audio/wav"),
        "mp3" => Ok("audio/mpeg"),
        "m4a" | "mp4" => Ok("audio/mp4"),
        "flac" => Ok("audio/flac"),
        "ogg" => Ok("audio/ogg"),
        "webm" => Ok("audio/webm"),
        "aac" => Ok("audio/aac"),
        _ => Err(ApiError::bad(
            "支持 WAV、MP3、M4A、MP4、FLAC、OGG、WebM、AAC 音频",
        )),
    }
}
pub async fn upload(
    State(state): State<App>,
    Auth(user): Auth,
    mut multipart: Multipart,
) -> Result<Json<Asset>> {
    let lock = state.storage_lock(&user.id).await;
    let _guard = lock
        .try_lock()
        .map_err(|_| ApiError::conflict("正在录音或上传，请结束后再上传文件"))?;
    let used = usage(&state, &user.id).await?;
    let pool = state.user_db(&user.id).await?;
    let mut field = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad("文件上传格式无效"))?
        .ok_or_else(|| ApiError::bad("缺少文件"))?;
    if field.name() != Some("file") {
        return Err(ApiError::bad("表单字段必须为 file"));
    }
    let name = field
        .file_name()
        .unwrap_or("audio.wav")
        .replace(['\\', '/', '\r', '\n', '\0'], "_");
    if name.chars().count() > 200 {
        return Err(ApiError::bad("文件名过长"));
    }
    let mime = mime(&name)?.to_string();
    let id = models::id();
    let path = state.asset_path(&user.id, &id);
    let partial = Partial(path.with_extension("part"));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial.0)
        .await?;
    let mut size = 0u64;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| ApiError::bad("上传中断或文件过大"))?
    {
        size += chunk.len() as u64;
        if size > state.config.max_upload {
            return Err(ApiError::bad("文件超过上传大小限制"));
        }
        if used + size > state.config.user_quota {
            return Err(ApiError::limit("存储空间不足，请删除旧会议"));
        }
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    drop(file);
    drop(field);
    if multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad("文件上传格式无效"))?
        .is_some()
    {
        return Err(ApiError::bad("每次只能上传一个文件"));
    }
    let duration = probe(&state, &partial.0).await?;
    tokio::fs::rename(&partial.0, &path).await?;
    if let Err(err) =
        sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,?,?,?,?)")
            .bind(&id)
            .bind(&name)
            .bind(size as i64)
            .bind(&mime)
            .bind(duration)
            .execute(&pool)
            .await
    {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(err.into());
    }
    Ok(Json(Asset {
        id,
        name,
        size: size as i64,
        mime_type: mime,
    }))
}
pub async fn get(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    download(&state, &user.id, &id, &headers, false).await
}
pub async fn provider(
    State(state): State<App>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    if token.len() != 64 {
        return Err(ApiError::missing());
    }
    let grant:Option<(String,String,String)>=sqlx::query_as("SELECT g.user_id,g.asset_id,g.job_id FROM provider_grants g JOIN users u ON u.id=g.user_id WHERE g.token_hash=? AND g.expires_at>? AND u.disabled=0").bind(crypto::hash_token(&token)).bind(chrono::Utc::now().timestamp()).fetch_optional(&state.central).await?;
    let (uid, aid, jid) = grant.ok_or_else(ApiError::missing)?;
    let pool = state.user_db(&uid).await?;
    let active: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM jobs WHERE id=? AND state='running'")
            .bind(jid)
            .fetch_optional(&pool)
            .await?;
    active.ok_or_else(ApiError::missing)?;
    download(&state, &uid, &aid, &headers, true).await
}
pub async fn grant(state: &App, uid: &str, aid: &str, jid: &str) -> Result<String> {
    let token = crypto::token();
    sqlx::query("INSERT INTO provider_grants(token_hash,user_id,asset_id,job_id,expires_at) VALUES(?,?,?,?,?)").bind(crypto::hash_token(&token)).bind(uid).bind(aid).bind(jid).bind(chrono::Utc::now().timestamp()+86400).execute(&state.central).await?;
    Ok(format!(
        "{}/api/v1/provider-assets/{token}",
        state.config.public_url
    ))
}
pub fn range(value: Option<&str>, size: u64) -> std::result::Result<(u64, u64, bool), ()> {
    if size == 0 {
        return Err(());
    }
    let Some(value) = value else {
        return Ok((0, size - 1, false));
    };
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') {
        return Err(());
    }
    let (a, b) = value.split_once('-').ok_or(())?;
    let (start, end) = if a.is_empty() {
        let suffix = b.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        (
            a.parse::<u64>().map_err(|_| ())?,
            if b.is_empty() {
                size - 1
            } else {
                b.parse::<u64>().map_err(|_| ())?.min(size - 1)
            },
        )
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok((start, end, true))
}
async fn download(
    state: &App,
    uid: &str,
    aid: &str,
    headers: &HeaderMap,
    allow_private: bool,
) -> Result<Response> {
    let pool = state.user_db(uid).await?;
    let asset: Asset = sqlx::query_as("SELECT id,name,size,mime_type FROM assets WHERE id=? AND (? OR NOT EXISTS(SELECT 1 FROM job_provider_assets WHERE asset_id=assets.id))")
        .bind(aid)
        .bind(allow_private)
        .fetch_one(&pool)
        .await?;
    let path = state.asset_path(uid, &asset.id);
    let mut file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    let (start, end, partial) = match range(
        headers.get(header::RANGE).and_then(|h| h.to_str().ok()),
        size,
    ) {
        Ok(v) => v,
        Err(()) => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{size}"))],
            )
                .into_response())
        }
    };
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let stream = tokio_util::io::ReaderStream::new(file.take(end - start + 1));
    let mut response = Body::from_stream(stream).into_response();
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        asset
            .mime_type
            .parse()
            .map_err(|_| ApiError::bad("无效媒体类型"))?,
    );
    h.insert(header::CONTENT_LENGTH, (end - start + 1).into());
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    h.insert(
        header::CONTENT_DISPOSITION,
        format!("inline; filename=\"{}.audio\"", asset.id)
            .parse()
            .unwrap(),
    );
    h.insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    if partial {
        h.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}").parse().unwrap(),
        );
    }
    Ok(response)
}
