use crate::{
    auth::Auth,
    crypto,
    error::{ApiError, Result},
    models::{self, Job, Meeting, Template, Transcript},
    state::App,
};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub async fn meeting(pool: &SqlitePool, id: &str) -> Result<Meeting> {
    Ok(
        sqlx::query_as("SELECT id,title,created_at,updated_at,asset_id FROM meetings WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await?,
    )
}
pub async fn new_meeting(pool: &SqlitePool, title: &str) -> Result<Meeting> {
    let title = validate(title, 1, 200, "会议标题")?;
    let id = models::id();
    let now = models::now();
    sqlx::query("INSERT INTO meetings(id,title,created_at,updated_at) VALUES(?,?,?,?)")
        .bind(&id)
        .bind(title)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    meeting(pool, &id).await
}
pub async fn touch(pool: &SqlitePool, mid: &str) -> Result<()> {
    sqlx::query("UPDATE meetings SET updated_at=? WHERE id=?")
        .bind(models::now())
        .bind(mid)
        .execute(pool)
        .await?;
    Ok(())
}
pub fn validate<'a>(value: &'a str, min: usize, max: usize, name: &str) -> Result<&'a str> {
    let value = value.trim();
    if !(min..=max).contains(&value.chars().count()) {
        return Err(ApiError::bad(format!("{name}长度需为 {min}–{max}")));
    }
    Ok(value)
}
#[derive(Deserialize)]
pub struct Search {
    search: Option<String>,
}
pub async fn meetings(
    State(state): State<App>,
    Auth(user): Auth,
    Query(input): Query<Search>,
) -> Result<Json<Vec<Meeting>>> {
    let pool = state.user_db(&user.id).await?;
    let search = input.search.unwrap_or_default();
    if search.len() > 800 {
        return Err(ApiError::bad("搜索内容过长"));
    }
    Ok(Json(sqlx::query_as("SELECT id,title,created_at,updated_at,asset_id FROM meetings WHERE instr(lower(title),lower(?))>0 ORDER BY updated_at DESC LIMIT 1000").bind(search).fetch_all(&pool).await?))
}
#[derive(Deserialize)]
pub struct Title {
    pub title: String,
}
pub async fn create_meeting(
    State(state): State<App>,
    Auth(user): Auth,
    Json(input): Json<Title>,
) -> Result<Json<Meeting>> {
    let pool = state.user_db(&user.id).await?;
    let m = new_meeting(&pool, &input.title).await?;
    state.emit(&user.id, json!({"type":"meeting","meeting_id":m.id}));
    Ok(Json(m))
}
pub async fn detail(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let pool = state.user_db(&user.id).await?;
    let m = meeting(&pool, &id).await?;
    let transcripts: Vec<Transcript> =
        sqlx::query_as("SELECT * FROM transcripts WHERE meeting_id=? ORDER BY timestamp,rowid")
            .bind(&id)
            .fetch_all(&pool)
            .await?;
    let summary: String = sqlx::query_scalar("SELECT summary FROM meetings WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await?;
    let jobs: Vec<Job> =
        sqlx::query_as("SELECT * FROM jobs WHERE meeting_id=? ORDER BY created_at DESC LIMIT 100")
            .bind(&id)
            .fetch_all(&pool)
            .await?;
    let recording_state: Option<String> = sqlx::query_scalar(
        "SELECT state FROM recordings WHERE meeting_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?;
    Ok(Json(
        json!({"meeting":m,"transcripts":transcripts,"summary":summary,"jobs":jobs,"recording_state":recording_state}),
    ))
}
pub async fn rename(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
    Json(input): Json<Title>,
) -> Result<Json<Meeting>> {
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &id).await?;
    let title = validate(&input.title, 1, 200, "会议标题")?;
    sqlx::query("UPDATE meetings SET title=?,updated_at=? WHERE id=?")
        .bind(title)
        .bind(models::now())
        .bind(&id)
        .execute(&pool)
        .await?;
    state.emit(&user.id, json!({"type":"meeting","meeting_id":id}));
    Ok(Json(meeting(&pool, &id).await?))
}
pub async fn delete_meeting(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let lock = state.storage_lock(&user.id).await;
    let _guard = lock
        .try_lock()
        .map_err(|_| ApiError::conflict("正在录音或上传，请结束后再删除会议"))?;
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &id).await?;
    let running: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recordings WHERE meeting_id=? AND state IN ('pending','running')",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await?;
    if running > 0 {
        return Err(ApiError::conflict("请先结束录音"));
    }
    let assets:Vec<String>=sqlx::query_scalar("SELECT DISTINCT asset_id FROM meetings WHERE id=? AND asset_id IS NOT NULL UNION SELECT asset_id FROM jobs WHERE meeting_id=? AND asset_id IS NOT NULL").bind(&id).bind(&id).fetch_all(&pool).await?;
    let jobs: Vec<String> = sqlx::query_scalar("SELECT id FROM jobs WHERE meeting_id=?")
        .bind(&id)
        .fetch_all(&pool)
        .await?;
    for jid in jobs {
        sqlx::query("DELETE FROM provider_grants WHERE job_id=?")
            .bind(jid)
            .execute(&state.central)
            .await?;
    }
    sqlx::query("DELETE FROM meetings WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await?;
    crate::transcription_media::cleanup(&state, &user.id, None).await?;
    for aid in assets {
        let refs:i64=sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM meetings WHERE asset_id=?)+(SELECT COUNT(*) FROM jobs WHERE asset_id=?)").bind(&aid).bind(&aid).fetch_one(&pool).await?;
        if refs == 0 {
            sqlx::query("DELETE FROM assets WHERE id=?")
                .bind(&aid)
                .execute(&pool)
                .await?;
            let _ = tokio::fs::remove_file(state.asset_path(&user.id, &aid)).await;
        }
    }
    state.emit(
        &user.id,
        json!({"type":"meeting","meeting_id":id,"deleted":true}),
    );
    Ok(Json(json!({"ok":true})))
}
pub async fn import_text(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
    Json(input): Json<models::TextInput>,
) -> Result<Json<Value>> {
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &id).await?;
    let text = validate(&input.text, 1, 1_000_000, "导入文本")?;
    if text.lines().count() > 10000 {
        return Err(ApiError::bad("单次导入最多 10000 行，请合并短行后导入"));
    }
    if crate::assets::usage(&state, &user.id).await? + (text.len() as u64) * 8
        > state.config.user_quota
    {
        return Err(ApiError::limit("存储空间不足，请删除旧会议"));
    }
    let mut tx = pool.begin().await?;
    for line in text.split('\n').map(str::trim).filter(|x| !x.is_empty()) {
        sqlx::query("INSERT INTO transcripts(id,meeting_id,transcript,timestamp,source) VALUES(?,?,?,?,'import')").bind(models::id()).bind(&id).bind(line).bind(models::now()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    touch(&pool, &id).await?;
    state.emit(&user.id, json!({"type":"transcript","meeting_id":id}));
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct EditTranscript {
    transcript: Option<String>,
    speaker: Option<String>,
}
pub async fn edit_transcript(
    State(state): State<App>,
    Auth(user): Auth,
    Path((mid, tid)): Path<(String, String)>,
    Json(input): Json<EditTranscript>,
) -> Result<Json<Transcript>> {
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &mid).await?;
    if let Some(ref text) = input.transcript {
        validate(text, 0, 100_000, "转写文本")?;
    }
    if let Some(ref speaker) = input.speaker {
        validate(speaker, 0, 100, "说话人")?;
    }
    let changed=sqlx::query("UPDATE transcripts SET transcript=COALESCE(?,transcript),speaker=COALESCE(?,speaker) WHERE id=? AND meeting_id=?")
        .bind(input.transcript).bind(input.speaker).bind(&tid).bind(&mid).execute(&pool).await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::missing());
    }
    touch(&pool, &mid).await?;
    state.emit(&user.id, json!({"type":"transcript","meeting_id":mid}));
    Ok(Json(
        sqlx::query_as("SELECT * FROM transcripts WHERE id=? AND meeting_id=?")
            .bind(tid)
            .bind(mid)
            .fetch_one(&pool)
            .await?,
    ))
}
#[derive(Deserialize)]
pub struct RenameSpeaker {
    from: String,
    to: String,
}
pub async fn speakers(
    State(state): State<App>,
    Auth(user): Auth,
    Path(mid): Path<String>,
    Json(input): Json<RenameSpeaker>,
) -> Result<Json<Value>> {
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &mid).await?;
    let to = validate(&input.to, 1, 100, "说话人")?;
    sqlx::query("UPDATE transcripts SET speaker=? WHERE meeting_id=? AND COALESCE(speaker,'')=?")
        .bind(to)
        .bind(&mid)
        .bind(input.from)
        .execute(&pool)
        .await?;
    touch(&pool, &mid).await?;
    state.emit(&user.id, json!({"type":"transcript","meeting_id":mid}));
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Summary {
    markdown: String,
}
pub async fn save_summary(
    State(state): State<App>,
    Auth(user): Auth,
    Path(mid): Path<String>,
    Json(input): Json<Summary>,
) -> Result<Json<Value>> {
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &mid).await?;
    validate(&input.markdown, 0, 1_000_000, "纪要")?;
    sqlx::query("UPDATE meetings SET summary=?,updated_at=? WHERE id=?")
        .bind(input.markdown)
        .bind(models::now())
        .bind(&mid)
        .execute(&pool)
        .await?;
    state.emit(&user.id, json!({"type":"meeting","meeting_id":mid}));
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Attach {
    asset_id: String,
}
pub async fn attach(
    State(state): State<App>,
    Auth(user): Auth,
    Path(mid): Path<String>,
    Json(input): Json<Attach>,
) -> Result<Json<Meeting>> {
    let pool = state.user_db(&user.id).await?;
    meeting(&pool, &mid).await?;
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM assets WHERE id=? AND NOT EXISTS(SELECT 1 FROM job_provider_assets WHERE asset_id=assets.id)")
        .bind(&input.asset_id)
        .fetch_optional(&pool)
        .await?;
    exists.ok_or_else(ApiError::missing)?;
    sqlx::query("UPDATE meetings SET asset_id=?,updated_at=? WHERE id=?")
        .bind(input.asset_id)
        .bind(models::now())
        .bind(&mid)
        .execute(&pool)
        .await?;
    Ok(Json(meeting(&pool, &mid).await?))
}
pub async fn templates(State(state): State<App>, Auth(user): Auth) -> Result<Json<Vec<Template>>> {
    let pool = state.user_db(&user.id).await?;
    Ok(Json(
        sqlx::query_as("SELECT * FROM templates ORDER BY builtin DESC,name")
            .fetch_all(&pool)
            .await?,
    ))
}
#[derive(Deserialize)]
pub struct TemplateInput {
    name: String,
    description: Option<String>,
    prompt: String,
}
pub async fn put_template(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
    Json(input): Json<TemplateInput>,
) -> Result<Json<Template>> {
    validate(&id, 1, 100, "模板标识")?;
    let name = validate(&input.name, 1, 100, "模板名称")?;
    let prompt = validate(&input.prompt, 1, 50_000, "模板提示")?;
    let description = input.description.unwrap_or_default();
    validate(&description, 0, 1000, "模板说明")?;
    let pool = state.user_db(&user.id).await?;
    let builtin: Option<bool> = sqlx::query_scalar("SELECT builtin FROM templates WHERE id=?")
        .bind(&id)
        .fetch_optional(&pool)
        .await?;
    if builtin == Some(true) {
        return Err(ApiError::bad("请复制内置模板后编辑"));
    }
    sqlx::query("INSERT INTO templates(id,name,description,prompt,builtin) VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,prompt=excluded.prompt").bind(&id).bind(name).bind(description).bind(prompt).execute(&pool).await?;
    Ok(Json(
        sqlx::query_as("SELECT * FROM templates WHERE id=?")
            .bind(id)
            .fetch_one(&pool)
            .await?,
    ))
}
pub async fn delete_template(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let pool = state.user_db(&user.id).await?;
    let changed = sqlx::query("DELETE FROM templates WHERE id=? AND builtin=0")
        .bind(id)
        .execute(&pool)
        .await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::bad("模板不存在或为内置模板"));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn get_settings(state: &App, uid: &str) -> Result<Value> {
    let asr = crate::providers::load(state, uid, "asr").await?;
    let summary = crate::providers::load(state, uid, "summary").await?;
    let language = state.setting(uid, "asr_language", "auto").await?;
    let mut asr = asr.settings_json(state, uid, "asr")?;
    asr["language"] = json!(language);
    Ok(json!({"asr":asr,"summary":summary.settings_json(state,uid,"summary")?}))
}
pub async fn settings(State(state): State<App>, Auth(user): Auth) -> Result<Json<Value>> {
    Ok(Json(get_settings(&state, &user.id).await?))
}
#[derive(Deserialize)]
pub struct SettingsInput {
    asr_key: Option<String>,
    summary_key: Option<String>,
    asr_language: Option<String>,
    asr_base_url: Option<String>,
    asr_model: Option<String>,
    summary_base_url: Option<String>,
    summary_model: Option<String>,
    region: Option<String>,
}
pub fn language(input: &str) -> Result<&str> {
    if [
        "auto", "zh", "en", "yue", "ja", "ko", "fr", "de", "ru", "pt", "es", "it", "ar", "hi",
        "id", "th", "tr", "uk", "vi",
    ]
    .contains(&input)
    {
        Ok(input)
    } else {
        Err(ApiError::bad("当前云模型不支持该语言"))
    }
}
pub async fn put_settings(
    State(state): State<App>,
    Auth(user): Auth,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Value>> {
    if input.region.as_deref().is_some_and(|r| r != "beijing") {
        return Err(ApiError::bad("当前部署仅启用北京地域"));
    }
    if let Some(ref lang) = input.asr_language {
        language(lang)?;
    }
    for key in [input.asr_key.as_ref(), input.summary_key.as_ref()]
        .into_iter()
        .flatten()
    {
        if key.len() < 8 || key.len() > 512 || key.chars().any(char::is_whitespace) {
            return Err(ApiError::bad("API Key 格式无效"));
        }
    }
    let pool = state.user_db(&user.id).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    for (purpose, base, model, new_key) in [
        (
            "asr",
            input.asr_base_url.as_deref(),
            input.asr_model.as_deref(),
            input.asr_key.is_some(),
        ),
        (
            "summary",
            input.summary_base_url.as_deref(),
            input.summary_model.as_deref(),
            input.summary_key.is_some(),
        ),
    ] {
        let (current_base,current_model,has_key):(Option<String>,Option<String>,bool)=sqlx::query_as("SELECT (SELECT value FROM settings WHERE key=?),(SELECT value FROM settings WHERE key=?),EXISTS(SELECT 1 FROM credentials WHERE purpose=?)")
            .bind(format!("{purpose}_base_url")).bind(format!("{purpose}_model")).bind(purpose).fetch_one(&mut *tx).await?;
        let old_profile = crate::providers::resolve(
            purpose,
            current_base.as_deref(),
            current_model.as_deref(),
            state.config.max_seconds,
        )?;
        let next_profile = crate::providers::resolve(
            purpose,
            base.or(current_base.as_deref()),
            model.or(current_model.as_deref()),
            state.config.max_seconds,
        )?;
        if has_key && old_profile.base_url != next_profile.base_url && !new_key {
            return Err(ApiError::bad(
                "切换服务地址时必须同时提供该服务的新 API Key，或先删除原凭据",
            ));
        }
    }
    for (purpose, key) in [("asr", input.asr_key), ("summary", input.summary_key)] {
        if let Some(key) = key {
            let encrypted = crypto::encrypt(&state.key, &format!("{}:{purpose}", user.id), &key)?;
            sqlx::query("INSERT INTO credentials(purpose,encrypted) VALUES(?,?) ON CONFLICT(purpose) DO UPDATE SET encrypted=excluded.encrypted").bind(purpose).bind(encrypted).execute(&mut *tx).await?;
        }
    }
    for (key, value) in [
        ("asr_language", input.asr_language),
        ("asr_base_url", input.asr_base_url),
        ("asr_model", input.asr_model),
        ("summary_base_url", input.summary_base_url),
        ("summary_model", input.summary_model),
    ] {
        if let Some(value) = value {
            sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).bind(value).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(Json(get_settings(&state, &user.id).await?))
}
pub async fn delete_credential(
    State(state): State<App>,
    Auth(user): Auth,
    Path(purpose): Path<String>,
) -> Result<Json<Value>> {
    if !["asr", "summary"].contains(&purpose.as_str()) {
        return Err(ApiError::missing());
    }
    let pool = state.user_db(&user.id).await?;
    sqlx::query("DELETE FROM credentials WHERE purpose=?")
        .bind(purpose)
        .execute(&pool)
        .await?;
    Ok(Json(json!({"ok":true})))
}
