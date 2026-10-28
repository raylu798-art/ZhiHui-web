use clap::{Parser, Subcommand};
use std::{io::Read, path::PathBuf};
use zhihui_web::{config::Config, state::AppState};

#[derive(Parser)]
#[command(name = "zhihui-web", version, about = "Independent ZhiHui Web server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    /// Initialize a new encryption key without overwriting an existing key.
    InitKey,
    /// Read the administrator password from stdin; never pass a password as an argument.
    CreateAdmin {
        #[arg(long)]
        username: String,
        /// Explicit local-only password-policy exception for the admin account.
        #[arg(long)]
        local_bootstrap: bool,
    },
    /// Create one invite. Output contains a bearer token and should be handled privately.
    Invite {
        #[arg(long, default_value_t = 7)]
        days: i64,
    },
    /// Online SQLite snapshots + asset copies + checked SHA256 manifest. Output must not exist.
    Backup {
        #[arg(long)]
        output: PathBuf,
    },
    Serve,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "zhihui_web=info".into()),
        )
        .init();
    let cli = Cli::parse();
    let config = Config::from_env()?;
    if matches!(cli.command, Some(Command::InitKey)) {
        zhihui_web::crypto::init_key(&config.master_key_file)?;
        println!("Encryption key created");
        return Ok(());
    }
    let state = AppState::open(config).await?;
    match cli.command.unwrap_or(Command::Serve) {
        Command::InitKey => unreachable!(),
        Command::CreateAdmin {
            username,
            local_bootstrap,
        } => {
            let mut password = String::new();
            std::io::stdin().take(2048).read_to_string(&mut password)?;
            let password = password.trim_end_matches(['\r', '\n']);
            if local_bootstrap {
                state.create_local_admin(&username, password).await?;
            } else {
                state.create_admin(&username, password).await?;
            }
            println!("Administrator created");
        }
        Command::Invite { days } => {
            println!(
                "{}",
                serde_json::to_string(
                    &zhihui_web::auth::invitation(&state, "cli", days)
                        .await
                        .map_err(|e| anyhow::anyhow!(e.2))?
                )?
            );
        }
        Command::Backup { output } => {
            zhihui_web::backup::create(&state, &output).await?;
            println!("Backup completed and verified");
        }
        Command::Serve => {
            state.ensure_serving_policy().await?;
            zhihui_web::jobs::recover(&state).await?;
            let _workers = zhihui_web::jobs::spawn(state.clone());
            let listener = tokio::net::TcpListener::bind(&state.config.bind).await?;
            tracing::info!(address=%state.config.bind,version=env!("CARGO_PKG_VERSION"),build=%state.config.build,"Web service listening");
            // Deliberately omit request-URI tracing: provider URLs and invitation URLs contain bearer secrets.
            axum::serve(listener, zhihui_web::router(state))
                .with_graceful_shutdown(shutdown())
                .await?;
        }
    }
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
