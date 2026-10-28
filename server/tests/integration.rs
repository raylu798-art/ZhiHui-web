use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tempfile::TempDir;
use tower::ServiceExt;
use zhihui_web::{
    api,
    config::Config,
    crypto, jobs, models,
    state::{App, AppState},
};

async fn app() -> (TempDir, App, Router) {
    let temp = TempDir::new().unwrap();
    let mut config = Config::from_env().unwrap();
    config.data_dir = temp.path().join("data");
    config.master_key_file = temp.path().join("secret/key");
    config.public_url = "http://localhost:8810".into();
    crypto::init_key(&config.master_key_file).unwrap();
    let state = AppState::open(config).await.unwrap();
    state
        .create_admin("admin", "strong-test-password")
        .await
        .unwrap();
    let router = zhihui_web::router(state.clone());
    (temp, state, router)
}
async fn req(
    router: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    body: Value,
) -> (StatusCode, Value, String) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("origin", "http://localhost:8810")
        .header("content-type", "application/json");
    if !cookie.is_empty() {
        builder = builder.header("cookie", cookie);
    }
    let response = router
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, cookie)
}
async fn login(router: &Router) -> String {
    let (status, _, cookie) = req(
        router,
        "POST",
        "/api/v1/auth/login",
        "",
        json!({"username":"admin","password":"strong-test-password"}),
    )
    .await;
    assert_eq!(status, 200);
    cookie
}
async fn seed_prepared(state: &App, uid: &str, jid: &str) -> String {
    let pool = state.user_db(uid).await.unwrap();
    let aid = models::id();
    std::fs::write(state.asset_path(uid, &aid), b"fLaCmock").unwrap();
    sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'provider-input.flac',8,'audio/flac',1)").bind(&aid).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO job_provider_assets(asset_id,job_id) VALUES(?,?)")
        .bind(&aid)
        .bind(jid)
        .execute(&pool)
        .await
        .unwrap();
    aid
}
async fn invited(router: &Router, admin: &str, name: &str) -> (String, String) {
    let (_, invite, _) = req(
        router,
        "POST",
        "/api/v1/admin/invitations",
        admin,
        json!({}),
    )
    .await;
    let token = invite["token"].as_str().unwrap();
    let (status, user, cookie) = req(
        router,
        "POST",
        "/api/v1/auth/accept-invite",
        "",
        json!({"token":token,"username":name,"password":"invited-password-123"}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _, _) = req(
        router,
        "POST",
        "/api/v1/auth/accept-invite",
        "",
        json!({"token":token,"username":"reused","password":"invited-password-123"}),
    )
    .await;
    assert_eq!(status, 400);
    (user["id"].as_str().unwrap().into(), cookie)
}

#[tokio::test]
async fn auth_invites_isolation_credentials_and_backup() {
    let (temp, state, router) = app().await;
    let admin = login(&router).await;
    let (uid, a) = invited(&router, &admin, "alice").await;
    let (_, b) = invited(&router, &admin, "bob").await;
    let (status, _, _) = req(&router, "GET", "/api/v1/auth/me", "", json!({})).await;
    assert_eq!(status, 401);
    let bad = Request::builder()
        .method("POST")
        .uri("/api/v1/meetings")
        .header("origin", "https://attacker.invalid")
        .header("cookie", &a)
        .header("content-type", "application/json")
        .body(Body::from("{\"title\":\"x\"}"))
        .unwrap();
    assert_eq!(router.clone().oneshot(bad).await.unwrap().status(), 403);
    let (_, meeting, _) = req(
        &router,
        "POST",
        "/api/v1/meetings",
        &a,
        json!({"title":"会议测试"}),
    )
    .await;
    let mid = meeting["id"].as_str().unwrap();
    assert_eq!(
        req(
            &router,
            "GET",
            &format!("/api/v1/meetings/{mid}"),
            &b,
            json!({})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        req(
            &router,
            "PATCH",
            &format!("/api/v1/meetings/{mid}"),
            &b,
            json!({"title":"stolen"})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/meetings/{mid}/import-text"),
            &a,
            json!({"text":"第一项决策\n第二项行动"})
        )
        .await
        .0,
        200
    );
    let (_, detail, _) = req(
        &router,
        "GET",
        &format!("/api/v1/meetings/{mid}"),
        &a,
        json!({}),
    )
    .await;
    assert_eq!(detail["transcripts"].as_array().unwrap().len(), 2);
    let first = detail["transcripts"][0]["id"].as_str().unwrap();
    assert_eq!(
        req(
            &router,
            "PATCH",
            &format!("/api/v1/meetings/{mid}/transcripts/{first}"),
            &a,
            json!({"speaker":""})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/meetings/{mid}/speakers/rename"),
            &a,
            json!({"from":"","to":"主持人"})
        )
        .await
        .0,
        200
    );
    let (_, renamed, _) = req(
        &router,
        "GET",
        &format!("/api/v1/meetings/{mid}"),
        &a,
        json!({}),
    )
    .await;
    assert!(renamed["transcripts"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["speaker"] == "主持人"));
    let key = "sk-never-return-or-store-plaintext";
    let (_, settings, _) = req(
        &router,
        "PUT",
        "/api/v1/settings",
        &a,
        json!({"asr_key":key,"summary_key":key}),
    )
    .await;
    assert_eq!(settings["asr"]["configured"], true);
    assert!(!settings.to_string().contains(key));
    let (_, settings_b, _) = req(&router, "GET", "/api/v1/settings", &b, json!({})).await;
    assert_eq!(settings_b["asr"]["configured"], false);
    let pool = state.user_db(&uid).await.unwrap();
    let encrypted: String =
        sqlx::query_scalar("SELECT encrypted FROM credentials WHERE purpose='asr'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!encrypted.contains(key));
    assert_eq!(
        crypto::decrypt(&state.key, &format!("{uid}:asr"), &encrypted).unwrap(),
        key
    );
    assert!(crypto::decrypt(&state.key, "someone-else:asr", &encrypted).is_err());
    let stored_tokens: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_all(&state.central)
        .await
        .unwrap();
    assert!(!stored_tokens.iter().any(|s| a.contains(s)));
    let (_, tpl, _) = req(
        &router,
        "PUT",
        "/api/v1/templates/my-template",
        &a,
        json!({"name":"私有","prompt":"输出决策"}),
    )
    .await;
    assert_eq!(tpl["builtin"], false);
    let (_, tpls, _) = req(&router, "GET", "/api/v1/templates", &b, json!({})).await;
    assert!(!tpls
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["id"] == "my-template"));
    assert_eq!(
        req(&router, "POST", "/api/v1/admin/invitations", &b, json!({}))
            .await
            .0,
        403
    );
    let asset_id = models::id();
    std::fs::write(state.asset_path(&uid, &asset_id), b"0123456789").unwrap();
    sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'sample.wav',10,'audio/wav',1)").bind(&asset_id).execute(&pool).await.unwrap();
    assert_eq!(
        req(
            &router,
            "GET",
            &format!("/api/v1/assets/{asset_id}"),
            &b,
            json!({})
        )
        .await
        .0,
        404
    );
    let ranged = Request::builder()
        .uri(format!("/api/v1/assets/{asset_id}"))
        .header("cookie", &a)
        .header("range", "bytes=2-5")
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(ranged).await.unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        &b"2345"[..]
    );
    let jid = models::id();
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,asset_id,state,created_at,updated_at) VALUES(?,'transcribe',?,?,'running',?,?)").bind(&jid).bind(mid).bind(&asset_id).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    let grant = zhihui_web::assets::grant(&state, &uid, &asset_id, &jid)
        .await
        .unwrap();
    let path = reqwest::Url::parse(&grant).unwrap().path().to_string();
    assert_eq!(req(&router, "GET", &path, "", json!({})).await.0, 200);
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/jobs/{jid}/cancel"),
            &b,
            json!({})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/jobs/{jid}/cancel"),
            &a,
            json!({})
        )
        .await
        .0,
        200
    );
    assert_eq!(req(&router, "GET", &path, "", json!({})).await.0, 404);
    let output = temp.path().join("backups/first");
    zhihui_web::backup::create(&state, &output).await.unwrap();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(output.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["master_key_included"], false);
    assert!(manifest["files"].as_array().unwrap().len() >= 3);
    assert!(zhihui_web::backup::create(&state, &output).await.is_err());
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,state,created_at,updated_at) VALUES('pending-disable','summary',?,'queued',?,?)").bind(mid).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    assert_eq!(
        req(
            &router,
            "PATCH",
            &format!("/api/v1/admin/users/{uid}"),
            &admin,
            json!({"disabled":true})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(&router, "GET", "/api/v1/auth/me", &a, json!({}))
            .await
            .0,
        401
    );
    let disabled_job: String =
        sqlx::query_scalar("SELECT state FROM jobs WHERE id='pending-disable'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(disabled_job, "cancelled");
    let (_, users, _) = req(&router, "GET", "/api/v1/admin/users", &admin, json!({})).await;
    assert!(users
        .as_array()
        .unwrap()
        .iter()
        .any(|u| u["id"] == uid && u["disabled"] == true));
    assert_eq!(
        req(
            &router,
            "PATCH",
            &format!("/api/v1/admin/users/{uid}"),
            &admin,
            json!({"disabled":false})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(&router, "POST", "/api/v1/auth/logout", &a, json!({}))
            .await
            .0,
        200
    );
    assert_eq!(
        req(&router, "GET", "/api/v1/auth/me", &a, json!({}))
            .await
            .0,
        401
    );
}

#[tokio::test]
async fn unknown_submission_response_is_interrupted_and_never_automatically_retried() {
    let (_temp, old, _) = app().await;
    let uid: String = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&old.central)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let mock = Router::new().route(
        "/api/v1/services/audio/asr/transcription",
        post(move || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                StatusCode::BAD_GATEWAY
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut config = old.config.clone();
    config.provider_base = base;
    let state = AppState::open(config).await.unwrap();
    let pool = state.user_db(&uid).await.unwrap();
    let enc = crypto::encrypt(&state.key, &format!("{uid}:asr"), "sk-mock-only").unwrap();
    sqlx::query("INSERT INTO credentials(purpose,encrypted) VALUES('asr',?)")
        .bind(enc)
        .execute(&pool)
        .await
        .unwrap();
    let m = api::new_meeting(&pool, "ambiguous-response").await.unwrap();
    let aid = models::id();
    std::fs::write(state.asset_path(&uid, &aid), b"mock-audio").unwrap();
    sqlx::query(
        "INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'mock.wav',10,'audio/wav',1)",
    )
    .bind(&aid)
    .execute(&pool)
    .await
    .unwrap();
    let jid = models::id();
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,asset_id,state,created_at,updated_at) VALUES(?,'transcribe',?,?,'queued',?,?)").bind(&jid).bind(&m.id).bind(aid).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    seed_prepared(&state, &uid, &jid).await;
    let workers = jobs::spawn(state.clone());
    let mut final_state = String::new();
    let mut message = String::new();
    for _ in 0..50 {
        let row: (String, Option<String>) =
            sqlx::query_as("SELECT state,error FROM jobs WHERE id=?")
                .bind(&jid)
                .fetch_one(&pool)
                .await
                .unwrap();
        if row.0 == "interrupted" {
            final_state = row.0;
            message = row.1.unwrap_or_default();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(final_state, "interrupted");
    assert!(message.contains("可能已经计费"));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    for worker in workers {
        worker.abort();
    }
    server.abort();
}

#[tokio::test]
async fn restart_preserves_upstream_id_and_never_repeats_ambiguous_submit() {
    let (_temp, state, _router) = app().await;
    let uid: String = sqlx::query_scalar("SELECT id FROM users WHERE username='admin'")
        .fetch_one(&state.central)
        .await
        .unwrap();
    let pool = state.user_db(&uid).await.unwrap();
    let m = api::new_meeting(&pool, "restart").await.unwrap();
    for (id, kind, provider, started) in [
        ("resume", "transcribe", Some("upstream-existing"), 1),
        ("ambiguous", "transcribe", None, 1),
        ("summary", "summary", None, 1),
        ("not-submitted", "transcribe", None, 0),
    ] {
        sqlx::query("INSERT INTO jobs(id,kind,meeting_id,state,provider_id,submission_started,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?)").bind(id).bind(kind).bind(&m.id).bind(provider).bind(started).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    }
    jobs::recover(&state).await.unwrap();
    let rows: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id,state,provider_id FROM jobs ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(rows.contains(&(
        "resume".into(),
        "queued".into(),
        Some("upstream-existing".into())
    )));
    assert!(rows.contains(&("ambiguous".into(), "interrupted".into(), None)));
    assert!(rows.contains(&("summary".into(), "interrupted".into(), None)));
    assert!(rows.contains(&("not-submitted".into(), "queued".into(), None)));
}

#[tokio::test]
async fn mock_file_provider_resumes_existing_task_replaces_active_and_preserves_revision() {
    let (temp, old, _) = app().await;
    let uid: String = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&old.central)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let submissions = Arc::new(AtomicUsize::new(0));
    let counter = submissions.clone();
    let result_url = format!("{base}/result");
    let mock=Router::new().route("/api/v1/services/audio/asr/transcription",post(move ||{let counter=counter.clone();async move{counter.fetch_add(1,Ordering::SeqCst);Json(json!({"output":{"task_id":"new-task"}}))}}))
        .route("/api/v1/tasks/{id}",get(move ||{let url=result_url.clone();async move{Json(json!({"output":{"task_status":"SUCCEEDED","results":[{"subtask_status":"SUCCEEDED","transcription_url":url}]}}))}}))
        .route("/result",get(||async{Json(json!({"transcripts":[{"sentences":[{"text":"云端结果","begin_time":100,"end_time":900,"speaker_id":1}]}]}))}));
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut config = old.config.clone();
    config.provider_base = base;
    config.poll_interval = Duration::from_millis(5);
    drop(old);
    let state = AppState::open(config).await.unwrap();
    let pool = state.user_db(&uid).await.unwrap();
    let encrypted = crypto::encrypt(&state.key, &format!("{uid}:asr"), "sk-mock-only").unwrap();
    sqlx::query("INSERT INTO credentials(purpose,encrypted) VALUES('asr',?)")
        .bind(encrypted)
        .execute(&pool)
        .await
        .unwrap();
    let m = api::new_meeting(&pool, "provider").await.unwrap();
    let aid = models::id();
    std::fs::write(state.asset_path(&uid, &aid), b"mock-audio").unwrap();
    sqlx::query(
        "INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'mock.wav',10,'audio/wav',1)",
    )
    .bind(&aid)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO transcripts(id,meeting_id,transcript,timestamp,source) VALUES('old',?,'old text',?,'realtime')").bind(&m.id).bind(models::now()).execute(&pool).await.unwrap();
    let jid = models::id();
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,asset_id,state,provider_id,submission_started,created_at,updated_at) VALUES(?,'transcribe',?,?,'running','upstream-existing',1,?,?)").bind(&jid).bind(&m.id).bind(&aid).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    let job = sqlx::query_as("SELECT * FROM jobs WHERE id=?")
        .bind(&jid)
        .fetch_one(&pool)
        .await
        .unwrap();
    jobs::transcribe(&state, &uid, &job).await.unwrap();
    assert_eq!(submissions.load(Ordering::SeqCst), 0);
    let transcript: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT transcript,speaker FROM transcripts WHERE meeting_id=?")
            .bind(&m.id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        transcript,
        vec![("云端结果".into(), Some("说话人 2".into()))]
    );
    let old_text: String =
        sqlx::query_scalar("SELECT transcript FROM transcript_revisions WHERE meeting_id=?")
            .bind(&m.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(old_text, "old text");
    let status: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id=?")
        .bind(&jid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "completed");
    assert!(jobs::validate_result_url(&state, "http://169.254.169.254/latest/meta-data").is_err());
    server.abort();
    drop(temp);
}

#[test]
fn range_boundaries_and_password_validation() {
    use zhihui_web::assets::range;
    assert_eq!(range(None, 100), Ok((0, 99, false)));
    assert_eq!(range(Some("bytes=10-19"), 100), Ok((10, 19, true)));
    assert_eq!(range(Some("bytes=-10"), 100), Ok((90, 99, true)));
    assert!(range(Some("bytes=100-"), 100).is_err());
    assert!(range(Some("bytes=1-2,3-4"), 100).is_err());
    assert!(range(Some("bytes=-0"), 100).is_err());
    assert!(zhihui_web::auth::validate_credentials("admin", "short").is_err());
    assert!(zhihui_web::auth::validate_credentials("../escape", "valid-test-password").is_err());
}

#[tokio::test]
async fn cancellation_during_billable_submission_keeps_upstream_id_and_discards_late_result() {
    let (_temp, old, _) = app().await;
    let uid: String = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&old.central)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let began = started.clone();
    let allow = release.clone();
    let mock = Router::new().route(
        "/api/v1/services/audio/asr/transcription",
        post(move || {
            let began = began.clone();
            let allow = allow.clone();
            async move {
                began.notify_one();
                allow.notified().await;
                Json(json!({"output":{"task_id":"accepted-after-cancel"}}))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut config = old.config.clone();
    config.provider_base = base;
    let state = AppState::open(config).await.unwrap();
    let router = zhihui_web::router(state.clone());
    let cookie = login(&router).await;
    let pool = state.user_db(&uid).await.unwrap();
    let enc = crypto::encrypt(&state.key, &format!("{uid}:asr"), "sk-mock-only").unwrap();
    sqlx::query("INSERT INTO credentials(purpose,encrypted) VALUES('asr',?)")
        .bind(enc)
        .execute(&pool)
        .await
        .unwrap();
    let m = api::new_meeting(&pool, "cancel").await.unwrap();
    let aid = models::id();
    std::fs::write(state.asset_path(&uid, &aid), b"mock-audio").unwrap();
    sqlx::query(
        "INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'mock.wav',10,'audio/wav',1)",
    )
    .bind(&aid)
    .execute(&pool)
    .await
    .unwrap();
    let jid = models::id();
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,asset_id,state,created_at,updated_at) VALUES(?,'transcribe',?,?,'running',?,?)").bind(&jid).bind(&m.id).bind(aid).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    let job = sqlx::query_as("SELECT * FROM jobs WHERE id=?")
        .bind(&jid)
        .fetch_one(&pool)
        .await
        .unwrap();
    seed_prepared(&state, &uid, &jid).await;
    let task_state = state.clone();
    let task_uid = uid.clone();
    let task = tokio::spawn(async move { jobs::transcribe(&task_state, &task_uid, &job).await });
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/jobs/{jid}/cancel"),
            &cookie,
            json!({})
        )
        .await
        .0,
        200
    );
    release.notify_one();
    task.await.unwrap().unwrap();
    let status: (String, Option<String>) =
        sqlx::query_as("SELECT state,provider_id FROM jobs WHERE id=?")
            .bind(&jid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        status,
        ("cancelled".into(), Some("accepted-after-cancel".into()))
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id=?")
        .bind(m.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let grants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_grants WHERE job_id=?")
        .bind(jid)
        .fetch_one(&state.central)
        .await
        .unwrap();
    assert_eq!(grants, 0);
    server.abort();
}

#[tokio::test]
async fn mock_realtime_pcm_stop_preserves_wav_and_transcript() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as Msg};
    let (_temp, old, _) = app().await;
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("ws://{}/realtime", provider.local_addr().unwrap());
    let mock=Router::new().route("/realtime",get(|ws:axum::extract::WebSocketUpgrade|async{ws.on_upgrade(|mut socket|async move{
        while let Some(Ok(axum::extract::ws::Message::Text(text)))=socket.recv().await {
            let value:Value=serde_json::from_str(&text).unwrap();match value["type"].as_str().unwrap_or("") {
                "input_audio_buffer.append"=>{
                    socket.send(axum::extract::ws::Message::Text(json!({"type":"input_audio_buffer.speech_started","item_id":"item1","audio_start_ms":0}).to_string().into())).await.unwrap();
                    socket.send(axum::extract::ws::Message::Text(json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"item1","transcript":"实时测试"}).to_string().into())).await.unwrap();
                },"session.finish"=>{socket.send(axum::extract::ws::Message::Text(json!({"type":"session.finished"}).to_string().into())).await.unwrap();break;},_=>{}
            }
        }
    })}));
    let provider_task = tokio::spawn(async move { axum::serve(provider, mock).await.unwrap() });
    let mut config = old.config.clone();
    config.realtime_url = upstream_url;
    let state = AppState::open(config).await.unwrap();
    let router = zhihui_web::router(state.clone());
    let cookie = login(&router).await;
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &cookie,
            json!({"asr_key":"sk-mock-only"})
        )
        .await
        .0,
        200
    );
    let (status, recording, _) = req(
        &router,
        "POST",
        "/api/v1/recordings",
        &cookie,
        json!({"title":"实时会议","language":"zh"}),
    )
    .await;
    assert_eq!(status, 200);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_url = format!(
        "ws://{}{}",
        listener.local_addr().unwrap(),
        recording["websocket_path"].as_str().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut request = ws_url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    request
        .headers_mut()
        .insert("origin", "http://localhost:8810".parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(Msg::Binary(vec![0, 0, 1, 0, 2, 0, 3, 0].into()))
        .await
        .unwrap();
    let transcript = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_str(transcript.to_text().unwrap()).unwrap();
    assert_eq!(value["type"], "transcript");
    assert_eq!(value["transcript"]["transcript"], "实时测试");
    socket
        .send(Msg::Text(json!({"type":"stop"}).to_string().into()))
        .await
        .unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_str(stopped.to_text().unwrap()).unwrap();
    assert_eq!(value["type"], "stopped");
    let uid: String = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&state.central)
        .await
        .unwrap();
    let pool = state.user_db(&uid).await.unwrap();
    let aid: String = sqlx::query_scalar("SELECT asset_id FROM meetings WHERE id=?")
        .bind(recording["meeting_id"].as_str().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut wav = hound::WavReader::open(state.asset_path(&uid, &aid)).unwrap();
    assert_eq!(wav.spec().sample_rate, 16000);
    assert_eq!(
        wav.samples::<i16>().map(|s| s.unwrap()).collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    let status: String = sqlx::query_scalar("SELECT state FROM recordings WHERE id=?")
        .bind(recording["id"].as_str().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "completed");
    provider_task.abort();
    server.abort();
}

fn media_tools(config: &mut Config) -> bool {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    if std::process::Command::new(&config.ffmpeg)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_err()
    {
        let candidate = root
            .parent()
            .unwrap()
            .join("ZhiHui/frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        if !candidate.is_file() {
            return false;
        }
        config.ffmpeg = candidate.to_string_lossy().into();
    }
    if std::process::Command::new(&config.ffprobe)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_err()
    {
        let candidate = root.join(".artifacts/tools/package/ffprobe.exe");
        if !candidate.is_file() {
            return false;
        }
        config.ffprobe = candidate.to_string_lossy().into();
    }
    true
}

#[tokio::test]
async fn stereo_downmix_preserves_both_channels_private_resume_backup_quota_and_cleanup() {
    let (temp, old, _) = app().await;
    let mut config = old.config.clone();
    if !media_tools(&mut config) {
        eprintln!(
            "SKIP real downmix: set ZHIHUI_FFMPEG and ZHIHUI_FFPROBE to available executables"
        );
        return;
    }
    let state = AppState::open(config).await.unwrap();
    let uid: String = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&state.central)
        .await
        .unwrap();
    let pool = state.user_db(&uid).await.unwrap();
    let m = api::new_meeting(&pool, "stereo").await.unwrap();
    let original = models::id();
    let path = state.asset_path(&uid, &original);
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 48000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, spec).unwrap();
    for sample in 0..96000 {
        let tone =
            (10000.0 * (sample as f64 * std::f64::consts::TAU * 440.0 / 48000.0).sin()) as i16;
        writer
            .write_sample(if sample < 48000 { tone } else { 0 })
            .unwrap();
        writer
            .write_sample(if sample >= 48000 { tone } else { 0 })
            .unwrap();
    }
    writer.finalize().unwrap();
    let original_bytes = std::fs::read(&path).unwrap();
    sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'stereo.wav',?,'audio/wav',2)").bind(&original).bind(original_bytes.len() as i64).execute(&pool).await.unwrap();
    sqlx::query("UPDATE meetings SET asset_id=? WHERE id=?")
        .bind(&original)
        .bind(&m.id)
        .execute(&pool)
        .await
        .unwrap();
    let jid = models::id();
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,asset_id,state,created_at,updated_at) VALUES(?,'transcribe',?,?,'running',?,?)").bind(&jid).bind(&m.id).bind(&original).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    let derived = zhihui_web::transcription_media::prepare(&state, &uid, &jid, &original)
        .await
        .unwrap();
    assert_ne!(derived, original);
    assert_eq!(
        zhihui_web::transcription_media::prepare(&state, &uid, &jid, &original)
            .await
            .unwrap(),
        derived
    );
    let info = zhihui_web::assets::probe_info(&state, &state.asset_path(&uid, &derived))
        .await
        .unwrap();
    assert_eq!(info.channels, 1);
    assert_eq!(info.sample_rate, 16000);
    assert!((info.duration - 2.0).abs() < 0.05);
    let decoded = std::process::Command::new(&state.config.ffmpeg)
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(state.asset_path(&uid, &derived))
        .args(["-f", "s16le", "-acodec", "pcm_s16le", "-"])
        .output()
        .unwrap();
    assert!(decoded.status.success());
    let samples: Vec<i16> = decoded
        .stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    assert!(samples.len() > 31000);
    for half in samples.chunks(samples.len() / 2).take(2) {
        let energy: f64 = half.iter().map(|s| (*s as f64).abs()).sum::<f64>() / half.len() as f64;
        assert!(energy > 1000.0, "a channel was lost during downmix");
    }
    assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
    let router = zhihui_web::router(state.clone());
    let cookie = login(&router).await;
    assert_eq!(
        req(
            &router,
            "GET",
            &format!("/api/v1/assets/{derived}"),
            &cookie,
            json!({})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/meetings/{}/asset", m.id),
            &cookie,
            json!({"asset_id":derived})
        )
        .await
        .0,
        404
    );
    let grant = zhihui_web::assets::grant(&state, &uid, &derived, &jid)
        .await
        .unwrap();
    let url = reqwest::Url::parse(&grant).unwrap();
    assert_eq!(req(&router, "GET", url.path(), "", json!({})).await.0, 200);
    let output = temp.path().join("prepared-backup");
    zhihui_web::backup::create(&state, &output).await.unwrap();
    assert!(output
        .join("users")
        .join(&uid)
        .join("assets")
        .join(&derived)
        .is_file());
    sqlx::query("UPDATE jobs SET provider_id='persisted-upstream',submission_started=1 WHERE id=?")
        .bind(&jid)
        .execute(&pool)
        .await
        .unwrap();
    jobs::recover(&state).await.unwrap();
    let linked: String =
        sqlx::query_scalar("SELECT asset_id FROM job_provider_assets WHERE job_id=?")
            .bind(&jid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(linked, derived);
    sqlx::query("UPDATE jobs SET state='running' WHERE id=?")
        .bind(&jid)
        .execute(&pool)
        .await
        .unwrap();
    jobs::finish(&state, &uid, &jid, "completed", None)
        .await
        .unwrap();
    assert!(!state.asset_path(&uid, &derived).exists());
    assert!(path.exists());
    assert_eq!(req(&router, "GET", url.path(), "", json!({})).await.0, 404);
    let attached: String = sqlx::query_scalar("SELECT asset_id FROM meetings WHERE id=?")
        .bind(&m.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attached, original);
    let second = models::id();
    sqlx::query("INSERT INTO jobs(id,kind,meeting_id,asset_id,state,created_at,updated_at) VALUES(?,'transcribe',?,?,'running',?,?)").bind(&second).bind(&m.id).bind(&original).bind(models::now()).bind(models::now()).execute(&pool).await.unwrap();
    let mut limited = state.config.clone();
    limited.user_quota = zhihui_web::assets::usage(&state, &uid).await.unwrap() + 512;
    let limited = AppState::open(limited).await.unwrap();
    assert!(
        zhihui_web::transcription_media::prepare(&limited, &uid, &second, &original)
            .await
            .is_err()
    );
    let submitted: i64 = sqlx::query_scalar("SELECT submission_started FROM jobs WHERE id=?")
        .bind(second)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(submitted, 0);
}

#[tokio::test]
async fn additive_web_schema_changes_are_backed_up_before_migration() {
    for missing in ["CREATE TABLE IF NOT EXISTS job_provider_assets(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE SET NULL);","CREATE TABLE IF NOT EXISTS job_requests(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE);"] {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("old.sqlite");
    let old=zhihui_web::db::USER.replace(missing,"");
    let pool = zhihui_web::db::open(&path, &old).await.unwrap();
    let m = api::new_meeting(&pool, "preserve").await.unwrap();
    pool.close().await;
    let pool = zhihui_web::db::open(&path, zhihui_web::db::USER)
        .await
        .unwrap();
    assert!(api::meeting(&pool, &m.id).await.is_ok());
    let files: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert!(files.iter().any(|p| p
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("meetings.before-provider-assets-")
        && p.extension().is_some_and(|x| x == "sqlite")));
    assert!(files
        .iter()
        .any(|p| p.extension().is_some_and(|x| x == "sha256")));
    }
}

#[tokio::test]
async fn job_request_keys_survive_completed_lost_response_restart_and_are_user_scoped() {
    let (_temp, state, router) = app().await;
    let admin = login(&router).await;
    let (_, me, _) = req(&router, "GET", "/api/v1/auth/me", &admin, json!({})).await;
    let uid = me["id"].as_str().unwrap();
    let pool = state.user_db(uid).await.unwrap();
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &admin,
            json!({"summary_key":"sk-idempotency-mock"})
        )
        .await
        .0,
        200
    );
    let (_, meeting, _) = req(
        &router,
        "POST",
        "/api/v1/meetings",
        &admin,
        json!({"title":"幂等请求"}),
    )
    .await;
    let mid = meeting["id"].as_str().unwrap();
    assert_eq!(
        req(
            &router,
            "POST",
            &format!("/api/v1/meetings/{mid}/import-text"),
            &admin,
            json!({"text":"记录决定"})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/templates/once-template",
            &admin,
            json!({"name":"一次性模板","prompt":"总结决策"})
        )
        .await
        .0,
        200
    );
    let request_id = models::id();
    let payload = json!({"request_id":request_id,"kind":"summary","meeting_id":mid,"template_id":"once-template"});
    let (status, created, _) = req(&router, "POST", "/api/v1/jobs", &admin, payload.clone()).await;
    assert_eq!(status, 200);
    let jid = created["id"].as_str().unwrap();
    assert_eq!(
        req(&router, "POST", "/api/v1/jobs", &admin, payload.clone())
            .await
            .1["id"],
        jid
    );
    // The response was lost and the original job completed before the client retries.
    sqlx::query("UPDATE jobs SET state='completed',progress=1 WHERE id=?")
        .bind(jid)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        req(
            &router,
            "DELETE",
            "/api/v1/settings/credentials/summary",
            &admin,
            json!({})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(
            &router,
            "DELETE",
            "/api/v1/templates/once-template",
            &admin,
            json!({})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &admin,
            json!({"asr_language":"zh"})
        )
        .await
        .0,
        200
    );
    let (status, replayed, _) = req(&router, "POST", "/api/v1/jobs", &admin, payload.clone()).await;
    assert_eq!(status, 200);
    assert_eq!(replayed["id"], jid);
    assert_eq!(replayed["state"], "completed");
    let mut changed = payload.clone();
    changed["language"] = json!("auto");
    assert_eq!(
        req(&router, "POST", "/api/v1/jobs", &admin, changed)
            .await
            .0,
        409
    );
    let restarted = AppState::open(state.config.clone()).await.unwrap();
    jobs::recover(&restarted).await.unwrap();
    let restarted_router = zhihui_web::router(restarted.clone());
    let (status, replayed, _) = req(
        &restarted_router,
        "POST",
        "/api/v1/jobs",
        &admin,
        payload.clone(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(replayed["id"], jid);
    assert_eq!(replayed["state"], "completed");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM jobs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let mut invalid = payload.clone();
    invalid["request_id"] = json!("not-a-uuid");
    assert_eq!(
        req(&restarted_router, "POST", "/api/v1/jobs", &admin, invalid)
            .await
            .0,
        400
    );
    let (_, other) = invited(&restarted_router, &admin, "other-user").await;
    assert_eq!(
        req(
            &restarted_router,
            "POST",
            "/api/v1/jobs",
            &other,
            payload.clone()
        )
        .await
        .0,
        404
    );
    assert_eq!(
        req(
            &restarted_router,
            "PUT",
            "/api/v1/settings",
            &other,
            json!({"summary_key":"sk-other-user-mock"})
        )
        .await
        .0,
        200
    );
    let (_, other_meeting, _) = req(
        &restarted_router,
        "POST",
        "/api/v1/meetings",
        &other,
        json!({"title":"独立任务"}),
    )
    .await;
    let other_mid = other_meeting["id"].as_str().unwrap();
    req(
        &restarted_router,
        "POST",
        &format!("/api/v1/meetings/{other_mid}/import-text"),
        &other,
        json!({"text":"独立决定"}),
    )
    .await;
    let other_payload = json!({"request_id":request_id,"kind":"summary","meeting_id":other_mid});
    let (status, other_job, _) = req(
        &restarted_router,
        "POST",
        "/api/v1/jobs",
        &other,
        other_payload.clone(),
    )
    .await;
    assert_eq!(status, 200);
    assert_ne!(other_job["id"], jid);
    assert_eq!(other_job["meeting_id"], other_mid);
    assert_eq!(
        req(
            &restarted_router,
            "POST",
            "/api/v1/jobs",
            &other,
            other_payload
        )
        .await
        .1["id"],
        other_job["id"]
    );
    // Concurrent identical requests bind one new job in one durable transaction.
    req(
        &restarted_router,
        "PUT",
        "/api/v1/settings",
        &admin,
        json!({"summary_key":"sk-idempotency-restored"}),
    )
    .await;
    let concurrent = json!({"request_id":models::id(),"kind":"summary","meeting_id":mid});
    let responses = futures_util::future::join_all((0..8).map(|_| {
        req(
            &restarted_router,
            "POST",
            "/api/v1/jobs",
            &admin,
            concurrent.clone(),
        )
    }))
    .await;
    let id = responses[0].1["id"].clone();
    assert!(responses
        .iter()
        .all(|(status, job, _)| *status == 200 && job["id"] == id));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM jobs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM job_requests")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn user_provider_profiles_are_atomic_private_allowlisted_and_never_reuse_old_host_keys() {
    use zhihui_web::providers::{self, Provider, DASHSCOPE_SUMMARY_BASE, TOKEN_PLAN_BASE};
    let (_temp, state, router) = app().await;
    let admin = login(&router).await;
    let (other_uid, other) = invited(&router, &admin, "profile-other").await;
    let (_, user, _) = req(&router, "GET", "/api/v1/auth/me", &admin, json!({})).await;
    let uid = user["id"].as_str().unwrap();
    let (_, defaults, _) = req(&router, "GET", "/api/v1/settings", &admin, json!({})).await;
    assert_eq!(defaults["asr"]["provider"], "dashscope");
    assert_eq!(defaults["summary"]["base_url"], DASHSCOPE_SUMMARY_BASE);
    assert_eq!(defaults["asr"]["capabilities"]["realtime"], true);
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &admin,
            json!({"asr_key":"sk-old-asr-dummy","summary_key":"sk-old-summary-dummy"})
        )
        .await
        .0,
        200
    );
    let change_without_keys = json!({"asr_base_url":TOKEN_PLAN_BASE,"asr_model":"qwen-audio-3.0-asr-flash","summary_base_url":TOKEN_PLAN_BASE,"summary_model":"qwen3.8-flash"});
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &admin,
            change_without_keys
        )
        .await
        .0,
        400
    );
    let (_, unchanged, _) = req(&router, "GET", "/api/v1/settings", &admin, json!({})).await;
    assert_eq!(unchanged["asr"]["provider"], "dashscope");
    assert_eq!(unchanged["summary"]["provider"], "dashscope");
    let key = "sk-test-token-plan-only-user";
    let profile = json!({"asr_base_url":TOKEN_PLAN_BASE,"asr_model":"qwen-audio-3.0-asr-flash","summary_base_url":TOKEN_PLAN_BASE,"summary_model":"qwen3.8-flash","asr_key":key,"summary_key":key});
    let (status, saved, _) = req(&router, "PUT", "/api/v1/settings", &admin, profile).await;
    assert_eq!(status, 200);
    assert_eq!(saved["asr"]["provider"], "token_plan");
    assert_eq!(saved["summary"]["model"], "qwen3.8-flash");
    assert_eq!(
        saved["asr"]["capabilities"],
        json!({"file_transcription":true,"realtime":false,"diarization":false,"max_duration_seconds":300})
    );
    assert!(!saved.to_string().contains(key));
    let token = providers::load(&state, uid, "summary").await.unwrap();
    assert_eq!(token.profile.provider, Provider::TokenPlan);
    assert_eq!(token.credential(&state, uid, "summary").unwrap(), key);
    assert_eq!(
        providers::summary_endpoint(&state, &token.profile),
        format!("{TOKEN_PLAN_BASE}/chat/completions")
    );
    let outsider = providers::load(&state, &other_uid, "summary")
        .await
        .unwrap();
    assert_eq!(outsider.profile.provider, Provider::Dashscope);
    assert!(outsider.credential(&state, &other_uid, "summary").is_err());
    let (_, other_settings, _) = req(&router, "GET", "/api/v1/settings", &other, json!({})).await;
    assert_eq!(other_settings["summary"]["configured"], false);
    assert_eq!(other_settings["summary"]["provider"], "dashscope");
    assert_eq!(req(&router,"PUT","/api/v1/settings",&admin,json!({"summary_base_url":"https://evil.invalid/compatible-mode/v1","asr_key":"sk-should-not-be-saved"})).await.0,400);
    assert_eq!(
        providers::load(&state, uid, "asr")
            .await
            .unwrap()
            .credential(&state, uid, "asr")
            .unwrap(),
        key
    );
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &admin,
            json!({"summary_model":"qwen-plus"})
        )
        .await
        .0,
        400
    );
    let pool = state.user_db(uid).await.unwrap();
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        req(
            &router,
            "POST",
            "/api/v1/recordings",
            &admin,
            json!({"title":"unsupported realtime"})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM meetings")
            .fetch_one(&pool)
            .await
            .unwrap(),
        before
    );
    let meeting = api::new_meeting(&pool, "native file limits").await.unwrap();
    assert_eq!(
        req(
            &router,
            "POST",
            "/api/v1/jobs",
            &admin,
            json!({"request_id":models::id(),"kind":"transcribe","meeting_id":meeting.id})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM jobs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let aid = models::id();
    sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES(?,'long.wav',1,'audio/wav',301)").bind(&aid).execute(&pool).await.unwrap();
    let payload = json!({"request_id":models::id(),"kind":"transcribe","meeting_id":meeting.id,"asset_id":aid});
    assert_eq!(
        req(&router, "POST", "/api/v1/jobs", &admin, payload.clone())
            .await
            .0,
        400
    );
    sqlx::query("UPDATE assets SET duration=300 WHERE id=?")
        .bind(&aid)
        .execute(&pool)
        .await
        .unwrap();
    let mut manual_language = payload.clone();
    manual_language["language"] = json!("zh");
    let (status, error, _) = req(&router, "POST", "/api/v1/jobs", &admin, manual_language).await;
    assert_eq!(status, 400);
    assert!(error.to_string().contains("自动语言识别"));
    let (status, job, _) = req(&router, "POST", "/api/v1/jobs", &admin, payload.clone()).await;
    assert_eq!(status, 200);
    sqlx::query("UPDATE jobs SET state='completed',submission_started=1 WHERE id=?")
        .bind(job["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        req(&router, "POST", "/api/v1/jobs", &admin, payload)
            .await
            .1["id"],
        job["id"]
    );
    // After explicit deletion, switching back to a different official host without a key is allowed.
    assert_eq!(
        req(
            &router,
            "DELETE",
            "/api/v1/settings/credentials/summary",
            &admin,
            json!({})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        req(
            &router,
            "PUT",
            "/api/v1/settings",
            &admin,
            json!({"summary_base_url":DASHSCOPE_SUMMARY_BASE,"summary_model":"qwen-plus"})
        )
        .await
        .0,
        200
    );
    let (_, restored, _) = req(&router, "GET", "/api/v1/settings", &admin, json!({})).await;
    assert_eq!(restored["summary"]["configured"], false);
    assert_eq!(restored["summary"]["provider"], "dashscope");
    assert_eq!(restored["asr"]["provider"], "token_plan");
}

#[tokio::test]
async fn local_admin_password_exception_is_explicit_persistent_and_rejected_on_public_listeners() {
    let temp = TempDir::new().unwrap();
    let mut config = Config::from_env().unwrap();
    config.data_dir = temp.path().join("data");
    config.master_key_file = temp.path().join("secrets/key");
    config.public_url = "http://localhost:8810".into();
    config.bind = "127.0.0.1:8810".into();
    crypto::init_key(&config.master_key_file).unwrap();
    let state = AppState::open(config.clone()).await.unwrap();
    let password = "local123";
    assert!(state.create_admin("admin", password).await.is_err());
    assert!(state.create_local_admin("other", password).await.is_err());
    assert!(state.create_local_admin("admin", "short").await.is_err());
    state.create_local_admin("admin", password).await.unwrap();
    assert!(state.ensure_serving_policy().await.is_ok());
    let router = zhihui_web::router(state.clone());
    let (status, user, cookie) = req(
        &router,
        "POST",
        "/api/v1/auth/login",
        "",
        json!({"username":"admin","password":password}),
    )
    .await;
    assert_eq!(status, 200);
    let uid = user["id"].as_str().unwrap();
    let pool = state.user_db(uid).await.unwrap();
    let marker: String =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='local_password_exception'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(marker, "true");
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(uid)
        .fetch_one(&state.central)
        .await
        .unwrap();
    assert_ne!(hash, password);
    assert!(crypto::verify_password(password, &hash));
    let (_, settings, _) = req(&router, "GET", "/api/v1/settings", &cookie, json!({})).await;
    assert_eq!(settings["asr"]["configured"], false);
    assert_eq!(settings["summary"]["configured"], false);
    let (_, invite, _) = req(
        &router,
        "POST",
        "/api/v1/admin/invitations",
        &cookie,
        json!({}),
    )
    .await;
    assert_eq!(
        req(
            &router,
            "POST",
            "/api/v1/auth/accept-invite",
            "",
            json!({"token":invite["token"],"username":"invited-short","password":password})
        )
        .await
        .0,
        400
    );
    let restarted = AppState::open(config.clone()).await.unwrap();
    assert!(restarted.ensure_serving_policy().await.is_ok());
    for (bind, origin) in [
        ("0.0.0.0:8810", "http://localhost:8810"),
        ("127.0.0.1:8810", "https://zhihui.helms.wiki"),
    ] {
        let mut public = config.clone();
        public.bind = bind.into();
        public.public_url = origin.into();
        let public = AppState::open(public).await.unwrap();
        assert!(public.ensure_serving_policy().await.is_err());
        assert!(public.create_local_admin("admin", password).await.is_err());
    }
    assert!(state.create_local_admin("admin", password).await.is_err()); // Never replaces an existing account.
}

#[tokio::test]
async fn public_version_exposes_only_optional_icp_site_metadata() {
    let (_temp, state, router) = app().await;
    let (status, initial, _) = req(&router, "GET", "/api/v1/version", "", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(
        initial["icp_registration"],
        json!(state.config.icp_registration)
    );

    let mut config = state.config.clone();
    config.icp_registration = Some("备案展示验证（测试）".into());
    let configured = AppState::open(config).await.unwrap();
    let router = zhihui_web::router(configured);
    let (status, value, cookie) = req(&router, "GET", "/api/v1/version", "", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(value["icp_registration"], "备案展示验证（测试）");
    assert!(cookie.is_empty());
    assert!(value.get("credentials").is_none());
    assert!(value.get("data_dir").is_none());
    assert!(value.get("master_key_file").is_none());
}
