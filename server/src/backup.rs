use crate::state::App;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

/// Each SQLite online snapshot is consistent; restore with the service stopped.
/// A live backup can include assets newer than its DB snapshot, never a referenced asset missing.
pub async fn create(state: &App, output: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        !output.exists(),
        "backup output already exists; never replace a backup"
    );
    let data = state.config.data_dir.canonicalize()?;
    let ancestor = output
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| anyhow::anyhow!("backup has no existing parent"))?
        .canonicalize()?;
    anyhow::ensure!(
        !ancestor.starts_with(&data),
        "backup must be outside data directory"
    );
    tokio::fs::create_dir_all(output).await?;
    let account_path = output.join("accounts.sqlite");
    snapshot(&state.central, &account_path).await?;
    let snapshot_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&account_path)
            .read_only(true),
    )
    .await?;
    let users: Vec<String> = sqlx::query_scalar("SELECT id FROM users")
        .fetch_all(&snapshot_pool)
        .await?;
    snapshot_pool.close().await;
    for uid in users {
        // Enumerate every referenced asset from this snapshot, including not-yet-finalized recordings.
        let pool = state.user_db(&uid).await?;
        let dir = output.join("users").join(&uid);
        tokio::fs::create_dir_all(dir.join("assets")).await?;
        let database = dir.join("meetings.sqlite");
        snapshot(&pool, &database).await?;
        let copy_pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&database)
                .read_only(true),
        )
        .await?;
        let (assets, live) = snapshot_asset_references(&copy_pool).await?;
        copy_pool.close().await;
        for aid in assets {
            tokio::fs::copy(state.asset_path(&uid, &aid), dir.join("assets").join(&aid)).await?;
        }
        // In-flight PCM recordings are not yet published assets, but are recoverable WAV files.
        for aid in live {
            let source = state.asset_path(&uid, &aid);
            if source.exists() {
                tokio::fs::copy(source, dir.join("assets").join(aid)).await?;
            }
        }
    }
    let output = output.to_path_buf();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut entries=Vec::new();collect(&output,&output,&mut entries)?;
        let manifest=json!({"format":1,"product_version":env!("CARGO_PKG_VERSION"),"created_at":chrono::Utc::now().to_rfc3339(),"files":entries,"master_key_included":false,"consistency":"SQLite online snapshots; restore while server is stopped. Keep the original master key separately."});
        std::fs::write(output.join("manifest.json"),serde_json::to_vec_pretty(&manifest)?)?;Ok(())
    }).await??;
    // Verify persisted manifest is readable before reporting success.
    let _: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(account_path.parent().unwrap().join("manifest.json")).await?,
    )?;
    Ok(())
}
async fn snapshot_asset_references(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let assets = sqlx::query_scalar("SELECT id FROM assets")
        .fetch_all(pool)
        .await?;
    let live =
        sqlx::query_scalar("SELECT asset_id FROM recordings WHERE state IN ('pending','running')")
            .fetch_all(pool)
            .await?;
    Ok((assets, live))
}
async fn snapshot(pool: &sqlx::SqlitePool, path: &Path) -> anyhow::Result<()> {
    let target = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid backup path"))?;
    sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(pool)
        .await?;
    let copy = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .read_only(true),
    )
    .await?;
    let check: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&copy)
        .await?;
    copy.close().await;
    anyhow::ensure!(check == "ok", "backup integrity check failed");
    Ok(())
}
fn collect(root: &Path, dir: &Path, entries: &mut Vec<serde_json::Value>) -> anyhow::Result<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .map(|entry| entry.map(|x| x.path()))
        .collect::<std::io::Result<_>>()?;
    files.sort();
    for path in files {
        if path.is_dir() {
            collect(root, &path, entries)?;
        } else {
            // SQLite may create transient shared memory beside a read-only snapshot; never include it.
            if path.to_string_lossy().ends_with("-shm") || path.to_string_lossy().ends_with("-wal")
            {
                let _ = std::fs::remove_file(path);
                continue;
            }
            let mut file = std::fs::File::open(&path)?;
            let mut hash = Sha256::new();
            let mut buffer = [0; 65536];
            loop {
                let len = file.read(&mut buffer)?;
                if len == 0 {
                    break;
                }
                hash.update(&buffer[..len]);
            }
            entries.push(json!({"path":path.strip_prefix(root)?.to_string_lossy().replace('\\',"/"),"size":file.metadata()?.len(),"sha256":hex::encode(hash.finalize())}));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn recording_completion_after_snapshot_does_not_remove_its_audio_reference() {
        let temp = tempfile::TempDir::new().unwrap();
        let pool = crate::db::open(&temp.path().join("live.sqlite"), crate::db::USER)
            .await
            .unwrap();
        let meeting = crate::api::new_meeting(&pool, "snapshot race")
            .await
            .unwrap();
        sqlx::query("INSERT INTO recordings(id,meeting_id,language,state,asset_id,created_at) VALUES('recording',?,'auto','running','in-flight-wav',?)").bind(&meeting.id).bind(crate::models::now()).execute(&pool).await.unwrap();
        let target = temp.path().join("copy.sqlite");
        snapshot(&pool, &target).await.unwrap();
        // The original race: recording becomes an asset only after the database snapshot.
        sqlx::query("UPDATE recordings SET state='completed'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO assets(id,name,size,mime_type,duration) VALUES('in-flight-wav','recording.wav',100,'audio/wav',1)").execute(&pool).await.unwrap();
        let copy = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(target)
                .read_only(true),
        )
        .await
        .unwrap();
        let (assets, live) = snapshot_asset_references(&copy).await.unwrap();
        assert!(assets.is_empty());
        assert_eq!(live, vec!["in-flight-wav"]);
        assert!(snapshot_asset_references(&pool).await.unwrap().1.is_empty());
    }
}
