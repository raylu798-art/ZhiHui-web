pub mod api;
pub mod assets;
pub mod auth;
pub mod backup;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod jobs;
pub mod models;
pub mod providers;
pub mod recordings;
pub mod state;
pub mod transcription_media;
// Preserve the byte-for-byte imported desktop template implementation.
#[rustfmt::skip]
pub mod template_types;

use axum::{
    extract::{DefaultBodyLimit, State},
    response::{
        sse::{Event, KeepAlive},
        Sse,
    },
    routing::{delete, get, post, put},
    Json, Router,
};
use futures_util::StreamExt;
use serde_json::json;
use state::App;
use std::{convert::Infallible, time::Duration};

pub fn router(state: App) -> Router {
    let limit = state.config.max_upload as usize + 1024 * 1024;
    let api = Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route("/auth/login", post(auth::login))
        .route("/auth/accept-invite", post(auth::accept))
        .route("/auth/me", get(auth::me))
        .route("/auth/logout", post(auth::logout))
        .route("/admin/invitations", post(auth::invite))
        .route("/admin/users", get(auth::users))
        .route("/admin/users/{id}", axum::routing::patch(auth::disable))
        .route("/meetings", get(api::meetings).post(api::create_meeting))
        .route(
            "/meetings/{id}",
            get(api::detail)
                .patch(api::rename)
                .delete(api::delete_meeting),
        )
        .route("/meetings/{id}/import-text", post(api::import_text))
        .route(
            "/meetings/{id}/transcripts/{tid}",
            axum::routing::patch(api::edit_transcript),
        )
        .route("/meetings/{id}/speakers/rename", post(api::speakers))
        .route("/meetings/{id}/summary", put(api::save_summary))
        .route("/meetings/{id}/asset", post(api::attach))
        .route(
            "/assets",
            post(assets::upload).layer(DefaultBodyLimit::max(limit)),
        )
        .route("/assets/{id}", get(assets::get))
        .route("/provider-assets/{token}", get(assets::provider))
        .route("/templates", get(api::templates))
        .route(
            "/templates/{id}",
            put(api::put_template).delete(api::delete_template),
        )
        .route("/settings", get(api::settings).put(api::put_settings))
        .route(
            "/settings/credentials/{purpose}",
            delete(api::delete_credential),
        )
        .route("/jobs", get(jobs::list).post(jobs::create))
        .route("/jobs/{id}/cancel", post(jobs::cancel))
        .route("/events", get(events))
        .route("/recordings", post(recordings::create))
        .route("/recordings/{id}/stream", get(recordings::stream))
        .fallback(|| async { error::ApiError::missing() })
        .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::origin_guard,
        ))
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        ));
    Router::new()
        .nest("/api/v1", api)
        .route("/health", get(health))
        .fallback_service(
            tower_http::services::ServeDir::new(&state.config.static_dir)
                .append_index_html_on_directories(true),
        )
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::if_not_present(
                axum::http::HeaderName::from_static("x-content-type-options"),
                axum::http::HeaderValue::from_static("nosniff"),
            ),
        )
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::if_not_present(
                axum::http::HeaderName::from_static("referrer-policy"),
                axum::http::HeaderValue::from_static("no-referrer"),
            ),
        )
        .with_state(state)
}
pub async fn health(State(state): State<App>) -> error::Result<Json<serde_json::Value>> {
    sqlx::query("SELECT 1").execute(&state.central).await?;
    Ok(Json(
        json!({"ok":true,"version":env!("CARGO_PKG_VERSION"),"build":state.config.build}),
    ))
}
pub async fn version(State(state): State<App>) -> Json<serde_json::Value> {
    Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"build":state.config.build,"icp_registration":state.config.icp_registration,"capabilities":["invited_accounts","file_asr","realtime_asr","summary","templates","markdown_export","browser_audio"]}),
    )
}
async fn events(
    State(state): State<App>,
    auth::Auth(user): auth::Auth,
) -> Sse<impl futures_util::Stream<Item = std::result::Result<Event, Infallible>>> {
    let rx = tokio_stream::wrappers::BroadcastStream::new(state.events.subscribe());
    let stream = rx.filter_map(move |item| {
        let uid = user.id.clone();
        async move {
            match item {
                Ok((owner, value)) if owner == uid => {
                    Some(Ok(Event::default().data(value.to_string())))
                }
                _ => None,
            }
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}
