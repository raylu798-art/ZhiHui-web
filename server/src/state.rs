use crate::{
    config::Config,
    crypto, db,
    error::{ApiError, Result},
    models,
};
use sqlx::SqlitePool;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Instant,
};
use tokio::sync::{broadcast, Mutex, RwLock, Semaphore};

pub type App = Arc<AppState>;
pub struct AppState {
    pub config: Config,
    pub central: SqlitePool,
    pub key: [u8; 32],
    pub http: reqwest::Client,
    pub pools: RwLock<HashMap<String, SqlitePool>>,
    pub events: broadcast::Sender<(String, serde_json::Value)>,
    pub recordings: Mutex<HashSet<String>>,
    pub realtime_slots: Arc<Semaphore>,
    pub storage_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub auth_attempts: Mutex<HashMap<String, (Instant, u32)>>,
    pub auth_slots: Arc<Semaphore>,
}
impl AppState {
    pub async fn open(config: Config) -> anyhow::Result<App> {
        tokio::fs::create_dir_all(config.data_dir.join("users")).await?;
        let key = crypto::load_key(&config.master_key_file)?;
        // A key inside the data volume would defeat separated database/key backup handling.
        if let (Ok(key_path), Ok(data_path)) = (
            config.master_key_file.canonicalize(),
            config.data_dir.canonicalize(),
        ) {
            anyhow::ensure!(
                !key_path.starts_with(data_path),
                "master key must be outside ZHIHUI_DATA_DIR"
            );
        }
        let central = db::open(&config.data_dir.join("accounts.sqlite"), db::CENTRAL).await?;
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let (events, _) = broadcast::channel(256);
        let slots = config.realtime_limit;
        let app = Arc::new(Self {
            config,
            central,
            key,
            http,
            pools: RwLock::new(HashMap::new()),
            events,
            recordings: Mutex::new(HashSet::new()),
            realtime_slots: Arc::new(Semaphore::new(slots)),
            storage_locks: Mutex::new(HashMap::new()),
            auth_attempts: Mutex::new(HashMap::new()),
            auth_slots: Arc::new(Semaphore::new(2)),
        });
        // Force verification now: a changed master key must fail startup, not silently lose keys.
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM users")
            .fetch_all(&app.central)
            .await?;
        for uid in ids {
            let pool = app.user_db(&uid).await?;
            let credentials: Vec<(String, String)> =
                sqlx::query_as("SELECT purpose,encrypted FROM credentials")
                    .fetch_all(&pool)
                    .await?;
            for (purpose, value) in credentials {
                crypto::decrypt(&app.key, &format!("{uid}:{purpose}"), &value)?;
            }
        }
        Ok(app)
    }
    pub async fn user_db(&self, uid: &str) -> anyhow::Result<SqlitePool> {
        uuid::Uuid::parse_str(uid)?;
        if let Some(pool) = self.pools.read().await.get(uid) {
            return Ok(pool.clone());
        }
        let mut pools = self.pools.write().await;
        if let Some(pool) = pools.get(uid) {
            return Ok(pool.clone());
        }
        let dir = self.config.data_dir.join("users").join(uid);
        tokio::fs::create_dir_all(dir.join("assets")).await?;
        let pool = db::open(&dir.join("meetings.sqlite"), db::USER).await?;
        for (tid, body) in builtin_templates() {
            let template: crate::template_types::Template = serde_json::from_str(body)?;
            let prompt = format!(
                "{}\n\n{}",
                template.to_section_instructions(),
                template.to_markdown_structure()
            );
            sqlx::query("INSERT OR IGNORE INTO templates(id,name,description,prompt,builtin) VALUES(?,?,?,?,1)")
                .bind(tid).bind(template.name).bind(template.description).bind(prompt).execute(&pool).await?;
        }
        pools.insert(uid.into(), pool.clone());
        Ok(pool)
    }
    pub fn asset_path(&self, uid: &str, aid: &str) -> std::path::PathBuf {
        self.config
            .data_dir
            .join("users")
            .join(uid)
            .join("assets")
            .join(aid)
    }
    pub async fn storage_lock(&self, uid: &str) -> Arc<Mutex<()>> {
        self.storage_locks
            .lock()
            .await
            .entry(uid.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
    pub fn emit(&self, uid: &str, value: serde_json::Value) {
        let _ = self.events.send((uid.to_string(), value));
    }
    pub async fn credential(&self, uid: &str, purpose: &str) -> Result<String> {
        let pool = self.user_db(uid).await?;
        let encrypted: Option<String> =
            sqlx::query_scalar("SELECT encrypted FROM credentials WHERE purpose=?")
                .bind(purpose)
                .fetch_optional(&pool)
                .await?;
        let encrypted = encrypted.ok_or_else(|| ApiError::bad("请先在设置中配置 API Key"))?;
        crypto::decrypt(&self.key, &format!("{uid}:{purpose}"), &encrypted).map_err(Into::into)
    }
    pub async fn setting(&self, uid: &str, name: &str, default: &str) -> Result<String> {
        let pool = self.user_db(uid).await?;
        Ok(sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
            .bind(name)
            .fetch_optional(&pool)
            .await?
            .unwrap_or_else(|| default.to_string()))
    }
    pub async fn create_admin(&self, username: &str, password: &str) -> anyhow::Result<()> {
        self.create_admin_account(username, password, false).await
    }
    pub async fn create_local_admin(&self, username: &str, password: &str) -> anyhow::Result<()> {
        self.create_admin_account(username, password, true).await
    }
    async fn create_admin_account(
        &self,
        username: &str,
        password: &str,
        local: bool,
    ) -> anyhow::Result<()> {
        if local {
            anyhow::ensure!(
                self.config.loopback_only(),
                "local-bootstrap requires a loopback listener and public origin"
            );
            crate::auth::validate_local_bootstrap(username, password)
                .map_err(|e| anyhow::anyhow!(e.2))?;
        } else {
            crate::auth::validate_credentials(username, password)
                .map_err(|e| anyhow::anyhow!(e.2))?;
        }
        let uid = models::id();
        let hash = crypto::hash_password(password)?;
        // Publish the local-only marker before the central account; partial failure cannot expose a weak unmarked login.
        let pool = self.user_db(&uid).await?;
        if local {
            sqlx::query(
                "INSERT INTO settings(key,value) VALUES('local_password_exception','true')",
            )
            .execute(&pool)
            .await?;
        }
        sqlx::query(
            "INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,'admin',?)",
        )
        .bind(&uid)
        .bind(username.trim())
        .bind(hash)
        .bind(models::now())
        .execute(&self.central)
        .await?;
        Ok(())
    }
    pub async fn ensure_serving_policy(&self) -> anyhow::Result<()> {
        if self.config.loopback_only() {
            return Ok(());
        }
        let users: Vec<String> = sqlx::query_scalar("SELECT id FROM users")
            .fetch_all(&self.central)
            .await?;
        for uid in users {
            let pool = self.user_db(&uid).await?;
            let marker: Option<String> = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key='local_password_exception'",
            )
            .fetch_optional(&pool)
            .await?;
            anyhow::ensure!(marker.as_deref()!=Some("true"),"local-bootstrap account exists; this database can only be served on a loopback listener and public origin");
        }
        Ok(())
    }
}
fn builtin_templates() -> [(&'static str, &'static str); 7] {
    [
        (
            "standard_meeting",
            include_str!("../templates/standard_meeting.json"),
        ),
        (
            "daily_standup",
            include_str!("../templates/daily_standup.json"),
        ),
        (
            "project_sync",
            include_str!("../templates/project_sync.json"),
        ),
        (
            "retrospective",
            include_str!("../templates/retrospective.json"),
        ),
        (
            "sales_marketing_client_call",
            include_str!("../templates/sales_marketing_client_call.json"),
        ),
        (
            "psychatric_session",
            include_str!("../templates/psychatric_session.json"),
        ),
        (
            "general_document",
            include_str!("../templates/general_document.json"),
        ),
    ]
}
