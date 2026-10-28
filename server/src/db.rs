use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use std::{path::Path, time::Duration};

pub async fn open(path: &Path, schema: &str) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    if schema == USER {
        let old: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .fetch_one(&pool)
        .await?;
        let new: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('job_provider_assets','job_requests')",
        )
        .fetch_one(&pool)
        .await?;
        if old == 1 && new < 2 {
            // Verify an online snapshot before the additive Web-only schema migration.
            let backup = path.with_file_name(format!(
                "meetings.before-provider-assets-{}.sqlite",
                uuid::Uuid::new_v4()
            ));
            sqlx::query("VACUUM INTO ?")
                .bind(
                    backup
                        .to_str()
                        .ok_or_else(|| anyhow::anyhow!("invalid database backup path"))?,
                )
                .execute(&pool)
                .await?;
            let copy = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(&backup)
                        .read_only(true),
                )
                .await?;
            let check: String = sqlx::query_scalar("PRAGMA integrity_check")
                .fetch_one(&copy)
                .await?;
            copy.close().await;
            anyhow::ensure!(check == "ok", "schema backup integrity check failed");
            use sha2::{Digest, Sha256};
            use tokio::io::AsyncReadExt;
            let mut file = tokio::fs::File::open(&backup).await?;
            let mut hash = Sha256::new();
            // Keep the migration future small on Windows' default async/test thread stacks.
            let mut buffer = vec![0u8; 65536];
            loop {
                let n = file.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            tokio::fs::write(
                backup.with_extension("sha256"),
                hex::encode(hash.finalize()),
            )
            .await?;
        }
    }
    sqlx::raw_sql(schema).execute(&pool).await?;
    Ok(pool)
}
pub const CENTRAL: &str = r#"
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invitations(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_by TEXT, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provider_grants(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, asset_id TEXT NOT NULL, job_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS grants_job ON provider_grants(job_id);
"#;
pub const USER: &str = r#"
CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,asset_id TEXT,summary TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS transcripts(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,transcript TEXT NOT NULL,timestamp TEXT NOT NULL,audio_start_time REAL,audio_end_time REAL,speaker TEXT,source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS transcripts_meeting ON transcripts(meeting_id,timestamp);
CREATE TABLE IF NOT EXISTS transcript_revisions(revision_id TEXT NOT NULL,id TEXT NOT NULL,meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,transcript TEXT NOT NULL,timestamp TEXT NOT NULL,audio_start_time REAL,audio_end_time REAL,speaker TEXT,source TEXT NOT NULL,PRIMARY KEY(revision_id,id));
CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL,mime_type TEXT NOT NULL,duration REAL NOT NULL);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,prompt TEXT NOT NULL,builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials(purpose TEXT PRIMARY KEY,encrypted TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,asset_id TEXT,template_id TEXT,language TEXT NOT NULL DEFAULT 'auto',state TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,error TEXT,provider_id TEXT,submission_started INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(kind,state,created_at);
CREATE TABLE IF NOT EXISTS job_provider_assets(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS job_requests(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,language TEXT NOT NULL,state TEXT NOT NULL,asset_id TEXT NOT NULL,created_at TEXT NOT NULL);
"#;
