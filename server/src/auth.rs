use crate::{
    crypto,
    error::{ApiError, Result},
    models::{self, User},
    state::App,
};
use axum::{
    extract::{FromRequestParts, Path, State},
    http::{request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, Instant};

pub struct Auth(pub User);
impl FromRequestParts<App> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &App) -> Result<Self> {
        let token = session_token(&parts.headers).ok_or_else(ApiError::auth)?;
        let user = sqlx::query_as::<_,User>("SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0")
            .bind(crypto::hash_token(&token)).bind(chrono::Utc::now().timestamp()).fetch_optional(&state.central).await?.ok_or_else(ApiError::auth)?;
        Ok(Auth(user))
    }
}
fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|x| x.trim().split_once('='))
        .find(|(k, _)| *k == "zhihui_session")
        .map(|(_, v)| v.to_string())
}
pub fn validate_credentials(username: &str, password: &str) -> Result<()> {
    validate_username(username)?;
    if !(12..=256).contains(&password.chars().count()) {
        return Err(ApiError::bad("密码需为 12–256 个字符"));
    }
    Ok(())
}
fn validate_username(username: &str) -> Result<()> {
    if !(3..=64).contains(&username.trim().chars().count())
        || !username
            .trim()
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '@'))
    {
        return Err(ApiError::bad("用户名需为 3–64 个字母、数字或 _-.@"));
    }
    Ok(())
}
pub fn validate_local_bootstrap(username: &str, password: &str) -> Result<()> {
    validate_username(username)?;
    if username.trim() != "admin" || !(8..=256).contains(&password.chars().count()) {
        return Err(ApiError::bad(
            "本机初始化仅允许 admin 账号，密码需为 8–256 个字符",
        ));
    }
    Ok(())
}
pub fn admin(user: &User) -> Result<()> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}
async fn session(state: &App, user: User) -> Result<Response> {
    let token = crypto::token();
    sqlx::query("DELETE FROM sessions WHERE expires_at<?")
        .bind(chrono::Utc::now().timestamp())
        .execute(&state.central)
        .await?;
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
        .bind(crypto::hash_token(&token))
        .bind(&user.id)
        .bind(chrono::Utc::now().timestamp() + 7 * 86400)
        .execute(&state.central)
        .await?;
    let mut response = Json(user).into_response();
    let secure = if state.config.secure_cookie() {
        "; Secure"
    } else {
        ""
    };
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "zhihui_session={token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=604800{secure}"
        ))
        .unwrap(),
    );
    Ok(response)
}
async fn throttle(state: &App, key: &str) -> Result<()> {
    let mut attempts = state.auth_attempts.lock().await;
    attempts.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(900));
    if attempts.len() > 10000 {
        return Err(ApiError::limit("登录请求过多，请稍后再试"));
    }
    let (_, count) = attempts
        .entry(key.to_lowercase())
        .or_insert((Instant::now(), 0));
    *count += 1;
    if *count > 10 {
        return Err(ApiError::limit("登录尝试过多，15 分钟后再试"));
    }
    Ok(())
}
#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}
pub async fn login(State(state): State<App>, Json(input): Json<Login>) -> Result<Response> {
    if input.username.trim().chars().count() > 64 || input.username.len() > 256 {
        return Err(ApiError::auth());
    }
    throttle(&state, input.username.trim()).await?;
    if input.password.len() > 1024 {
        return Err(ApiError::auth());
    }
    let permit = state
        .auth_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::limit("登录请求繁忙，请稍后再试"))?;
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT id,username,role,password_hash FROM users WHERE username=? AND disabled=0",
    )
    .bind(input.username.trim())
    .fetch_optional(&state.central)
    .await?;
    // Hash even unknown users to reduce timing differences.
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Some((id, username, role, hash)) = row {
            if crypto::verify_password(&input.password, &hash) {
                return Some(User { id, username, role });
            }
        } else {
            let _ = crypto::hash_password(&input.password);
        }
        None
    })
    .await
    .map_err(|_| ApiError::auth())?
    .ok_or_else(ApiError::auth)?;
    state
        .auth_attempts
        .lock()
        .await
        .remove(&result.username.to_lowercase());
    session(&state, result).await
}
#[derive(Deserialize)]
pub struct Accept {
    token: String,
    username: String,
    password: String,
}
pub async fn accept(State(state): State<App>, Json(input): Json<Accept>) -> Result<Response> {
    throttle(&state, "invite-accept").await?;
    validate_credentials(&input.username, &input.password)?;
    if input.token.len() != 64 {
        return Err(ApiError::bad("邀请链接无效或已过期"));
    }
    let permit = state
        .auth_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::limit("登录请求繁忙，请稍后再试"))?;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crypto::hash_password(&input.password)
    })
    .await
    .map_err(|_| ApiError::auth())??;
    let uid = models::id();
    let mut tx = state.central.begin().await?;
    let update = sqlx::query(
        "UPDATE invitations SET used_by=? WHERE token_hash=? AND used_by IS NULL AND expires_at>?",
    )
    .bind(&uid)
    .bind(crypto::hash_token(&input.token))
    .bind(chrono::Utc::now().timestamp())
    .execute(&mut *tx)
    .await?;
    if update.rows_affected() != 1 {
        return Err(ApiError::bad("邀请链接无效或已过期"));
    }
    let insert = sqlx::query(
        "INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,'user',?)",
    )
    .bind(&uid)
    .bind(input.username.trim())
    .bind(hash)
    .bind(models::now())
    .execute(&mut *tx)
    .await;
    if let Err(err) = insert {
        if err
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(ApiError::conflict("用户名已存在"));
        }
        return Err(err.into());
    }
    tx.commit().await?;
    state.user_db(&uid).await?;
    session(
        &state,
        User {
            id: uid,
            username: input.username.trim().into(),
            role: "user".into(),
        },
    )
    .await
}
pub async fn me(Auth(user): Auth) -> Json<User> {
    Json(user)
}
pub async fn logout(State(state): State<App>, headers: HeaderMap) -> Result<Response> {
    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?")
            .bind(crypto::hash_token(&token))
            .execute(&state.central)
            .await?;
    }
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        HeaderValue::from_static("zhihui_session=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0"),
    );
    Ok(response)
}
pub async fn invitation(state: &App, by: &str, days: i64) -> Result<serde_json::Value> {
    let token = crypto::token();
    let expires = chrono::Utc::now() + chrono::Duration::days(days.clamp(1, 30));
    sqlx::query("INSERT INTO invitations(token_hash,expires_at,created_by) VALUES(?,?,?)")
        .bind(crypto::hash_token(&token))
        .bind(expires.timestamp())
        .bind(by)
        .execute(&state.central)
        .await?;
    Ok(
        json!({"token":token,"url":format!("{}/?invite={token}",state.config.public_url),"expires_at":expires.to_rfc3339()}),
    )
}
pub async fn invite(State(state): State<App>, Auth(user): Auth) -> Result<Json<serde_json::Value>> {
    admin(&user)?;
    Ok(Json(invitation(&state, &user.id, 7).await?))
}
pub async fn users(
    State(state): State<App>,
    Auth(user): Auth,
) -> Result<Json<Vec<serde_json::Value>>> {
    admin(&user)?;
    let users: Vec<(String, String, String, bool)> =
        sqlx::query_as("SELECT id,username,role,disabled FROM users ORDER BY created_at")
            .fetch_all(&state.central)
            .await?;
    Ok(Json(users.into_iter().map(|(id,username,role,disabled)|json!({"id":id,"username":username,"role":role,"disabled":disabled})).collect()))
}
#[derive(Deserialize)]
pub struct Disable {
    disabled: bool,
}
pub async fn disable(
    State(state): State<App>,
    Auth(user): Auth,
    Path(id): Path<String>,
    Json(input): Json<Disable>,
) -> Result<Json<serde_json::Value>> {
    admin(&user)?;
    if id == user.id {
        return Err(ApiError::bad("不能禁用当前账号"));
    }
    let changed = sqlx::query("UPDATE users SET disabled=? WHERE id=?")
        .bind(input.disabled)
        .bind(&id)
        .execute(&state.central)
        .await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::missing());
    }
    if input.disabled {
        sqlx::query("DELETE FROM sessions WHERE user_id=?")
            .bind(&id)
            .execute(&state.central)
            .await?;
        sqlx::query("DELETE FROM provider_grants WHERE user_id=?")
            .bind(&id)
            .execute(&state.central)
            .await?;
        let pool = state.user_db(&id).await?;
        sqlx::query("UPDATE jobs SET state='cancelled',error='账号已由管理员禁用；已提交的云任务可能仍产生费用',updated_at=? WHERE state IN ('queued','running')").bind(crate::models::now()).execute(&pool).await?;
        sqlx::query("UPDATE recordings SET state='interrupted' WHERE state='pending'")
            .execute(&pool)
            .await?;
        crate::transcription_media::cleanup(&state, &id, None).await?;
        state.emit(&id, json!({"type":"job","account_disabled":true}));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn origin_guard(
    State(state): State<App>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) {
        let origin = req
            .headers()
            .get(axum::http::header::ORIGIN)
            .and_then(|x| x.to_str().ok());
        if origin != Some(&state.config.public_url) {
            return ApiError(
                StatusCode::FORBIDDEN,
                "origin_mismatch",
                "请求来源不匹配".into(),
            )
            .into_response();
        }
        if req
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|v| v != "same-origin" && v != "none")
        {
            return ApiError::forbidden().into_response();
        }
    }
    next.run(req).await
}
