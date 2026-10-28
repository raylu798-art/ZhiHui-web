use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

pub type Result<T> = std::result::Result<T, ApiError>;
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str, pub String);
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.2)
    }
}
impl std::error::Error for ApiError {}
impl ApiError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid_input", message.into())
    }
    pub fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, "not_found", "未找到资源".into())
    }
    pub fn auth() -> Self {
        Self(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录".into())
    }
    pub fn forbidden() -> Self {
        Self(StatusCode::FORBIDDEN, "forbidden", "无权执行此操作".into())
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, "conflict", message.into())
    }
    pub fn limit(message: impl Into<String>) -> Self {
        Self(
            StatusCode::TOO_MANY_REQUESTS,
            "limit_exceeded",
            message.into(),
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":self.2}})),
        )
            .into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        if matches!(err, sqlx::Error::RowNotFound) {
            return Self::missing();
        }
        tracing::error!(error = %err, "database operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "存储操作失败".into(),
        )
    }
}
impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        tracing::error!(error = %err, "file operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "文件操作失败".into(),
        )
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(_: anyhow::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "操作失败，请检查服务器日志".into(),
        )
    }
}
