use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, sqlx::FromRow, Debug)]
pub struct User {
    pub id: String,
    pub username: String,
    pub role: String,
}
#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub asset_id: Option<String>,
}
#[derive(Clone, Serialize, sqlx::FromRow, Debug)]
pub struct Transcript {
    pub id: String,
    pub meeting_id: String,
    pub transcript: String,
    pub timestamp: String,
    pub audio_start_time: Option<f64>,
    pub audio_end_time: Option<f64>,
    pub speaker: Option<String>,
    pub source: String,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub builtin: bool,
}
#[derive(Clone, Serialize, sqlx::FromRow, Debug)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub meeting_id: String,
    pub state: String,
    pub progress: f64,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, sqlx::FromRow)]
pub struct JobInternal {
    pub id: String,
    pub kind: String,
    pub meeting_id: String,
    pub asset_id: Option<String>,
    pub template_id: Option<String>,
    pub language: String,
    pub state: String,
    pub provider_id: Option<String>,
    pub submission_started: bool,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub mime_type: String,
}
#[derive(Deserialize)]
pub struct TextInput {
    pub text: String,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
