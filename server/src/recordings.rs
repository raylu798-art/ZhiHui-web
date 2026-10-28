use crate::{
    api, assets,
    auth::Auth,
    error::{ApiError, Result},
    jobs,
    models::{self, Transcript},
    state::App,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::HeaderMap,
    response::Response,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as ProviderMessage};

#[derive(Deserialize)]
pub struct Create {
    title: String,
    language: Option<String>,
}
#[derive(Clone, sqlx::FromRow)]
struct Recording {
    id: String,
    meeting_id: String,
    language: String,
    asset_id: String,
}
pub async fn create(
    State(state): State<App>,
    Auth(user): Auth,
    Json(input): Json<Create>,
) -> Result<Json<Value>> {
    let provider = crate::providers::load(&state, &user.id, "asr").await?;
    crate::providers::require_realtime_asr(&provider.profile)?;
    let _reservation = state.recordings.lock().await;
    provider.credential(&state, &user.id, "asr")?;
    let lang = input
        .language
        .unwrap_or(state.setting(&user.id, "asr_language", "auto").await?);
    api::language(&lang)?;
    let pool = state.user_db(&user.id).await?;
    sqlx::query("UPDATE recordings SET state='interrupted' WHERE state='pending' AND created_at<?")
        .bind((chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339())
        .execute(&pool)
        .await?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM recordings WHERE state IN ('pending','running')")
            .fetch_one(&pool)
            .await?;
    if count > 0 {
        return Err(ApiError::conflict("每个账号只能进行一个实时录音"));
    }
    if assets::usage(&state, &user.id).await? + 1024 * 1024 > state.config.user_quota {
        return Err(ApiError::limit("存储空间不足"));
    }
    let m = api::new_meeting(&pool, &input.title).await?;
    let id = models::id();
    let aid = models::id();
    sqlx::query("INSERT INTO recordings(id,meeting_id,language,state,asset_id,created_at) VALUES(?,?,?,'pending',?,?)").bind(&id).bind(&m.id).bind(lang).bind(aid).bind(models::now()).execute(&pool).await?;
    state.emit(&user.id, json!({"type":"meeting","meeting_id":m.id}));
    Ok(Json(
        json!({"id":id,"meeting_id":m.id,"websocket_path":format!("/api/v1/recordings/{id}/stream")}),
    ))
}
pub async fn stream(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    if headers
        .get(axum::http::header::ORIGIN)
        .and_then(|x| x.to_str().ok())
        != Some(&state.config.public_url)
    {
        return Err(ApiError::forbidden());
    }
    let provider = crate::providers::load(&state, &user.id, "asr").await?;
    crate::providers::require_realtime_asr(&provider.profile)?;
    let permit = state
        .realtime_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::limit("实时识别会话已满，请稍后再试"))?;
    let pool = state.user_db(&user.id).await?;
    let recording: Recording =
        sqlx::query_as("SELECT * FROM recordings WHERE id=? AND state='pending'")
            .bind(&id)
            .fetch_one(&pool)
            .await?;
    let key = provider.credential(&state, &user.id, "asr")?;
    let mut active = state.recordings.lock().await;
    if !active.insert(user.id.clone()) {
        return Err(ApiError::conflict("每个账号只能进行一个实时录音"));
    }
    drop(active);
    let updated =
        sqlx::query("UPDATE recordings SET state='running' WHERE id=? AND state='pending'")
            .bind(&id)
            .execute(&pool)
            .await?;
    if updated.rows_affected() != 1 {
        state.recordings.lock().await.remove(&user.id);
        return Err(ApiError::conflict("录音会话已经使用"));
    }
    let failed_state = state.clone();
    let failed_uid = user.id.clone();
    let failed_recording = recording.clone();
    Ok(ws
        .max_frame_size(65536)
        .max_message_size(65536)
        .on_failed_upgrade(move |_| {
            tokio::spawn(async move {
                let _ = finalize(&failed_state, &failed_uid, &failed_recording, false).await;
                failed_state.recordings.lock().await.remove(&failed_uid);
            });
        })
        .on_upgrade(move |mut socket| async move {
            let _permit = permit;
            let result = run(&state, &user.id, &recording, &key, &mut socket).await;
            if let Err(error) = result {
                let _ = finalize(&state, &user.id, &recording, false).await;
                let _ = socket
                    .send(Message::Text(
                        json!({"type":"error","message":error.2}).to_string().into(),
                    ))
                    .await;
            }
            let _ = socket.close().await;
            state.recordings.lock().await.remove(&user.id);
        }))
}
fn header(bytes: u32) -> [u8; 44] {
    let mut out = [0u8; 44];
    out[..4].copy_from_slice(b"RIFF");
    out[4..8].copy_from_slice(&(bytes + 36).to_le_bytes());
    out[8..12].copy_from_slice(b"WAVE");
    out[12..16].copy_from_slice(b"fmt ");
    out[16..20].copy_from_slice(&16u32.to_le_bytes());
    out[20..22].copy_from_slice(&1u16.to_le_bytes());
    out[22..24].copy_from_slice(&1u16.to_le_bytes());
    out[24..28].copy_from_slice(&16000u32.to_le_bytes());
    out[28..32].copy_from_slice(&32000u32.to_le_bytes());
    out[32..34].copy_from_slice(&2u16.to_le_bytes());
    out[34..36].copy_from_slice(&16u16.to_le_bytes());
    out[36..40].copy_from_slice(b"data");
    out[40..44].copy_from_slice(&bytes.to_le_bytes());
    out
}
async fn run(
    state: &App,
    uid: &str,
    recording: &Recording,
    key: &str,
    socket: &mut WebSocket,
) -> Result<()> {
    let lock = state.storage_lock(uid).await;
    let _guard = lock
        .try_lock()
        .map_err(|_| ApiError::conflict("正在上传文件，请结束后开始录音"))?;
    let used = assets::usage(state, uid).await?;
    let limit = state
        .config
        .max_upload
        .min(state.config.max_seconds * 32000 + 44)
        .min(state.config.user_quota.saturating_sub(used));
    let path = state.asset_path(uid, &recording.asset_id);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await?;
    file.write_all(&header(0)).await?;
    let result = connected(state, uid, recording, key, socket, &mut file, limit).await;
    let stopped = result.as_ref().is_ok_and(|v| *v);
    file.sync_all().await?;
    drop(file);
    finalize(state, uid, recording, stopped).await?;
    if stopped {
        let _ = socket
            .send(Message::Text(
                json!({"type":"stopped","meeting_id":recording.meeting_id})
                    .to_string()
                    .into(),
            ))
            .await;
    }
    result.map(|_| ())
}
async fn connected(
    state: &App,
    uid: &str,
    recording: &Recording,
    key: &str,
    socket: &mut WebSocket,
    file: &mut tokio::fs::File,
    limit: u64,
) -> Result<bool> {
    let url = format!(
        "{}?model=qwen3-asr-flash-realtime",
        state.config.realtime_url
    );
    let mut request = url
        .into_client_request()
        .map_err(|_| ApiError::bad("实时识别地址配置错误"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {key}")
            .parse()
            .map_err(|_| ApiError::bad("API Key 无效"))?,
    );
    request
        .headers_mut()
        .insert("OpenAI-Beta", "realtime=v1".parse().unwrap());
    let (mut upstream, _) = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| ApiError::bad("实时识别连接超时"))?
    .map_err(|_| ApiError::bad("无法连接实时识别，请检查 API Key 和模型权限"))?;
    let mut session = json!({"input_audio_format":"pcm","sample_rate":16000,"turn_detection":{"type":"server_vad","threshold":0.2,"silence_duration_ms":800}});
    if recording.language != "auto" {
        session["input_audio_transcription"] = json!({"language":recording.language});
    }
    upstream
        .send(ProviderMessage::Text(
            json!({"event_id":models::id(),"type":"session.update","session":session})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|_| ApiError::bad("实时识别初始化失败"))?;
    let mut count = 0u64;
    let mut stopping = false;
    let mut finishing = std::pin::pin!(tokio::time::sleep(Duration::from_secs(24 * 3600)));
    let deadline = tokio::time::sleep(Duration::from_secs(state.config.max_seconds));
    tokio::pin!(deadline);
    let mut auth_timer = tokio::time::interval(Duration::from_secs(30));
    let mut times: HashMap<String, (Option<f64>, Option<f64>)> = HashMap::new();
    let mut received = std::collections::HashSet::new();
    loop {
        tokio::select! {
            _=&mut deadline=>return Err(ApiError::limit("录音达到时长限制，已保存接收的音频")),
            _=&mut finishing,if stopping=>return Err(ApiError::bad("云服务结束响应超时，已保存录音和转写")),
            _=auth_timer.tick()=>{
                let active:Option<i64>=sqlx::query_scalar("SELECT 1 FROM users WHERE id=? AND disabled=0").bind(uid).fetch_optional(&state.central).await?;
                if active.is_none(){return Err(ApiError::auth());}
            },
            frame=socket.recv(),if !stopping=>{
                match frame {
                    Some(Ok(Message::Binary(bytes)))=>{
                        if bytes.len()>65536 || bytes.len()%2!=0 { return Err(ApiError::bad("音频帧必须为 PCM16，且不超过 64KiB")); }
                        count+=bytes.len() as u64;
                        if count+44>limit { return Err(ApiError::limit("已达到音频或存储空间限制，已保存接收的录音")); }
                        file.write_all(&bytes).await?;
                        upstream.send(ProviderMessage::Text(json!({"event_id":models::id(),"type":"input_audio_buffer.append","audio":STANDARD.encode(&bytes)}).to_string().into())).await.map_err(|_|ApiError::bad("实时识别连接中断，已保存接收的录音"))?;
                    },
                    Some(Ok(Message::Text(text)))=>{
                        let value:Value=serde_json::from_str(&text).map_err(|_|ApiError::bad("实时控制消息无效"))?;
                        if value["type"]!="stop" { return Err(ApiError::bad("不支持的实时控制消息")); }
                        upstream.send(ProviderMessage::Text(json!({"event_id":models::id(),"type":"session.finish"}).to_string().into())).await.map_err(|_|ApiError::bad("实时识别连接已断开"))?;
                        stopping=true;finishing.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(20));
                    },
                    Some(Ok(Message::Ping(data)))=>{let _=socket.send(Message::Pong(data)).await;},
                    Some(Ok(Message::Pong(_)))=>{},_=>return Ok(false),
                }
            },
            frame=upstream.next()=>{
                let text=match frame { Some(Ok(ProviderMessage::Text(t)))=>t,Some(Ok(ProviderMessage::Ping(data)))=>{let _=upstream.send(ProviderMessage::Pong(data)).await;continue;},Some(Ok(ProviderMessage::Pong(_)))=>continue,_=>return Err(ApiError::bad("云端实时识别连接已中断，已保存录音")) };
                let value:Value=serde_json::from_str(&text).map_err(|_|ApiError::bad("云服务返回了无效消息"))?;
                let item=value["item_id"].as_str().unwrap_or("").to_string();
                match value["type"].as_str().unwrap_or("") {
                    "input_audio_buffer.speech_started"=>{times.entry(item).or_default().0=value["audio_start_ms"].as_f64().map(|x|x/1000.0);},
                    "input_audio_buffer.speech_stopped"=>{times.entry(item).or_default().1=value["audio_end_ms"].as_f64().map(|x|x/1000.0);},
                    "conversation.item.input_audio_transcription.completed"=>{
                        if !received.insert(item.clone()) { continue; }
                        let text=value["transcript"].as_str().unwrap_or("").trim(); if text.is_empty(){continue;}
                        let (start,end)=times.remove(&item).unwrap_or((None,Some(count as f64/32000.0)));
                        let row=Transcript{id:models::id(),meeting_id:recording.meeting_id.clone(),transcript:text.to_string(),timestamp:models::now(),audio_start_time:start,audio_end_time:end,speaker:None,source:"realtime".into()};
                        let pool=state.user_db(uid).await?; let mut tx=pool.begin().await?;jobs::insert_transcript(&mut tx,&row).await?;tx.commit().await?;
                        api::touch(&pool,&recording.meeting_id).await?;state.emit(uid,json!({"type":"transcript","meeting_id":recording.meeting_id}));
                        if socket.send(Message::Text(json!({"type":"transcript","transcript":row}).to_string().into())).await.is_err(){return Ok(false);}
                    },
                    "session.finished"=>return Ok(stopping),"error"|"conversation.item.input_audio_transcription.failed"=>return Err(ApiError::bad("云端识别失败，请检查账户额度和模型权限")),_=>{},
                }
            }
        }
    }
}
async fn finalize(state: &App, uid: &str, recording: &Recording, completed: bool) -> Result<()> {
    let pool = state.user_db(uid).await?;
    let path = state.asset_path(uid, &recording.asset_id);
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.len() > 44 {
            let bytes = (meta.len() - 44).min(u32::MAX as u64) as u32;
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .await?;
            file.seek(std::io::SeekFrom::Start(0)).await?;
            file.write_all(&header(bytes)).await?;
            file.sync_all().await?;
            sqlx::query("INSERT OR IGNORE INTO assets(id,name,size,mime_type,duration) VALUES(?,'recording.wav',?,'audio/wav',?)").bind(&recording.asset_id).bind(meta.len() as i64).bind(bytes as f64/32000.0).execute(&pool).await?;
            sqlx::query("UPDATE meetings SET asset_id=?,updated_at=? WHERE id=?")
                .bind(&recording.asset_id)
                .bind(models::now())
                .bind(&recording.meeting_id)
                .execute(&pool)
                .await?;
        } else {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    sqlx::query("UPDATE recordings SET state=? WHERE id=?")
        .bind(if completed {
            "completed"
        } else {
            "interrupted"
        })
        .bind(&recording.id)
        .execute(&pool)
        .await?;
    state.emit(uid,json!({"type":"meeting","meeting_id":recording.meeting_id,"recording_state":if completed{"completed"}else{"interrupted"}}));
    Ok(())
}
pub async fn recover(state: &App, uid: &str) -> Result<()> {
    let pool = state.user_db(uid).await?;
    let rows: Vec<Recording> =
        sqlx::query_as("SELECT * FROM recordings WHERE state IN ('running','pending')")
            .fetch_all(&pool)
            .await?;
    for row in rows {
        finalize(state, uid, &row, false).await?;
    }
    Ok(())
}
