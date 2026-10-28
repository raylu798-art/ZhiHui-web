//! Private, durable provider input. Always downmix all channels before diarized ASR.
use crate::{
    assets,
    error::{ApiError, Result},
    jobs, models,
    state::App,
};
use std::{path::PathBuf, time::Duration};

struct Unpublished(Option<PathBuf>);
impl Drop for Unpublished {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub async fn prepare(state: &App, uid: &str, jid: &str, original: &str) -> Result<String> {
    let pool = state.user_db(uid).await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT asset_id FROM job_provider_assets WHERE job_id=?")
            .bind(jid)
            .fetch_optional(&pool)
            .await?;
    if let Some(aid) = existing {
        if tokio::fs::try_exists(state.asset_path(uid, &aid)).await? {
            return Ok(aid);
        }
        cleanup(state, uid, Some(jid)).await?;
    }
    let lock = state.storage_lock(uid).await;
    let _guard = lock
        .try_lock()
        .map_err(|_| ApiError::conflict("请结束当前录音或上传后再提交文件转写"))?;
    if !jobs::active(state, uid, jid).await? {
        return Err(ApiError::conflict("任务已取消"));
    }
    let source = state.asset_path(uid, original);
    let info = assets::probe_info(state, &source).await?;
    let used = assets::usage(state, uid).await?;
    let limit = state
        .config
        .max_upload
        .min(state.config.user_quota.saturating_sub(used + 1024 * 1024));
    if limit < 1024 * 1024 {
        return Err(ApiError::limit("存储空间不足，无法准备云端识别音频"));
    }
    let aid = models::id();
    let path = state.asset_path(uid, &aid);
    let partial = path.with_extension("part");
    let mut unpublished = Unpublished(Some(partial.clone()));
    let mut child = tokio::process::Command::new(&state.config.ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-max_alloc",
            "67108864",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "wav,mp3,mov,flac,ogg,matroska,webm,aac",
            "-i",
        ])
        .arg(&source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "flac",
            "-compression_level",
            "5",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-t",
        ])
        .arg(state.config.max_seconds.to_string())
        .arg("-fs")
        .arg((limit + 1).to_string())
        .args(["-f", "flac", "-n"])
        .arg(&partial)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ApiError::bad("服务器缺少音频转换工具 ffmpeg，请联系管理员"))?;
    let deadline = tokio::time::sleep(state.config.convert_timeout);
    tokio::pin!(deadline);
    let mut check = tokio::time::interval(Duration::from_millis(500));
    let status = loop {
        tokio::select! {
            result=child.wait()=>break result?,
            _=&mut deadline=>{let _=child.kill().await;return Err(ApiError::bad("音频转换超时，尚未提交云端任务"));},
            _=check.tick()=>{if !jobs::active(state,uid,jid).await?{let _=child.kill().await;return Err(ApiError::conflict("任务已取消"));}}
        }
    };
    if !status.success() {
        return Err(ApiError::bad("音频转换失败，尚未提交云端任务"));
    }
    let size = tokio::fs::metadata(&partial).await?.len();
    if size > limit || assets::usage(state, uid).await? > state.config.user_quota {
        return Err(ApiError::limit(
            "转换后的音频超过文件或存储限制，尚未提交云端任务",
        ));
    }
    let converted = assets::probe_info(state, &partial).await?;
    if converted.channels != 1
        || converted.sample_rate != 16000
        || (converted.duration - info.duration).abs() > 2.0
    {
        return Err(ApiError::bad(
            "转换后的音频格式或时长不一致，尚未提交云端任务",
        ));
    }
    // Publish the file and ownership link before any chargeable provider submission.
    tokio::fs::rename(&partial, &path).await?;
    unpublished.0 = Some(path);
    let mut tx = pool.begin().await?;
    let active: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM jobs WHERE id=? AND state='running'")
            .bind(jid)
            .fetch_optional(&mut *tx)
            .await?;
    if active.is_none() {
        return Err(ApiError::conflict("任务已取消"));
    }
    sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'provider-input.flac',?,'audio/flac',?)").bind(&aid).bind(size as i64).bind(converted.duration).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO job_provider_assets(asset_id,job_id) VALUES(?,?)")
        .bind(&aid)
        .bind(jid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    unpublished.0 = None;
    Ok(aid)
}

/// Only internally linked derivatives can be removed here; original meeting audio is never selected.
pub async fn cleanup(state: &App, uid: &str, jid: Option<&str>) -> Result<()> {
    let pool = state.user_db(uid).await?;
    let ids: Vec<String> = if let Some(jid) = jid {
        sqlx::query_scalar("SELECT asset_id FROM job_provider_assets WHERE job_id=?")
            .bind(jid)
            .fetch_all(&pool)
            .await?
    } else {
        sqlx::query_scalar("SELECT p.asset_id FROM job_provider_assets p LEFT JOIN jobs j ON j.id=p.job_id WHERE j.id IS NULL OR j.state NOT IN ('queued','running')").fetch_all(&pool).await?
    };
    for aid in ids {
        // Delete bytes first: a transient file error leaves a discoverable private row for retry.
        match tokio::fs::remove_file(state.asset_path(uid, &aid)).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        sqlx::query("DELETE FROM assets WHERE id=? AND EXISTS(SELECT 1 FROM job_provider_assets WHERE asset_id=?)").bind(&aid).bind(&aid).execute(&pool).await?;
    }
    Ok(())
}

pub async fn recover(state: &App, uid: &str) -> Result<()> {
    cleanup(state, uid, None).await?;
    let dir = state.config.data_dir.join("users").join(uid).join("assets");
    let mut files = tokio::fs::read_dir(dir).await?;
    while let Some(file) = files.next_entry().await? {
        if file.path().extension().is_some_and(|e| e == "part") {
            tokio::fs::remove_file(file.path()).await?;
        }
    }
    Ok(())
}
