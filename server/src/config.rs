use std::{path::PathBuf, time::Duration};

#[derive(Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub master_key_file: PathBuf,
    pub public_url: String,
    pub bind: String,
    pub build: String,
    pub icp_registration: Option<String>,
    pub max_upload: u64,
    pub user_quota: u64,
    pub max_seconds: u64,
    pub realtime_limit: usize,
    pub ffprobe: String,
    pub ffmpeg: String,
    pub convert_timeout: Duration,
    pub provider_base: String,
    pub realtime_url: String,
    pub poll_interval: Duration,
}
impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
        let num = |key: &str, default: u64| -> anyhow::Result<u64> {
            Ok(std::env::var(key)
                .ok()
                .map(|x| x.parse())
                .transpose()?
                .unwrap_or(default))
        };
        let config = Self {
            data_dir: get("ZHIHUI_DATA_DIR", "./data").into(),
            static_dir: get("ZHIHUI_STATIC_DIR", "../frontend/out").into(),
            master_key_file: get("ZHIHUI_MASTER_KEY_FILE", "./secrets/master_key").into(),
            public_url: get("ZHIHUI_PUBLIC_URL", "http://localhost:8810")
                .trim_end_matches('/')
                .into(),
            bind: get("ZHIHUI_BIND", "127.0.0.1:8810"),
            build: get("ZHIHUI_BUILD", "5"),
            icp_registration: parse_icp_registration(
                std::env::var("ZHIHUI_ICP_NUMBER").ok().as_deref(),
            )?,
            max_upload: num("ZHIHUI_MAX_UPLOAD_BYTES", 200 * 1024 * 1024)?,
            user_quota: num("ZHIHUI_USER_QUOTA_BYTES", 5 * 1024 * 1024 * 1024)?,
            max_seconds: num("ZHIHUI_MAX_AUDIO_SECONDS", 7200)?,
            realtime_limit: num("ZHIHUI_REALTIME_LIMIT", 2)? as usize,
            ffprobe: get("ZHIHUI_FFPROBE", "ffprobe"),
            ffmpeg: get("ZHIHUI_FFMPEG", "ffmpeg"),
            convert_timeout: Duration::from_secs(
                num("ZHIHUI_CONVERT_TIMEOUT_SECONDS", 600)?.clamp(30, 3600),
            ),
            provider_base: get("ZHIHUI_DASHSCOPE_BASE", "https://dashscope.aliyuncs.com")
                .trim_end_matches('/')
                .into(),
            realtime_url: get(
                "ZHIHUI_DASHSCOPE_REALTIME_URL",
                "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
            ),
            poll_interval: Duration::from_secs(num("ZHIHUI_POLL_SECONDS", 3)?),
        };
        let url = reqwest::Url::parse(&config.public_url)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "ZHIHUI_PUBLIC_URL must be an origin"
        );
        anyhow::ensure!(
            config.max_upload > 0
                && config.user_quota >= config.max_upload
                && config.realtime_limit > 0,
            "invalid limits"
        );
        Ok(config)
    }
    pub fn secure_cookie(&self) -> bool {
        self.public_url.starts_with("https://")
    }
    pub fn loopback_only(&self) -> bool {
        loopback_addresses(&self.bind, &self.public_url)
    }
}
fn parse_icp_registration(input: Option<&str>) -> anyhow::Result<Option<String>> {
    let input = input.unwrap_or("");
    anyhow::ensure!(
        !input.chars().any(char::is_control),
        "ZHIHUI_ICP_NUMBER must not contain control characters"
    );
    let value = input.trim();
    anyhow::ensure!(
        value.chars().count() <= 100,
        "ZHIHUI_ICP_NUMBER must contain at most 100 characters"
    );
    Ok((!value.is_empty()).then(|| value.to_string()))
}
pub fn loopback_addresses(bind: &str, public_url: &str) -> bool {
    let bind = bind
        .parse::<std::net::SocketAddr>()
        .ok()
        .is_some_and(|address| address.ip().is_loopback());
    let public = reqwest::Url::parse(public_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
                    .is_some_and(|address| address.is_loopback())
        });
    bind && public
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_icp_registration_is_trimmed_bounded_and_rejects_controls() {
        assert_eq!(parse_icp_registration(None).unwrap(), None);
        assert_eq!(parse_icp_registration(Some("   ")).unwrap(), None);
        assert_eq!(
            parse_icp_registration(Some("  备案展示验证（测试）  ")).unwrap(),
            Some("备案展示验证（测试）".into())
        );
        assert!(parse_icp_registration(Some(&"备".repeat(100))).is_ok());
        assert!(parse_icp_registration(Some(&"备".repeat(101))).is_err());
        for input in ["test\n", "test\rnumber", "test\tnumber", "test\0number"] {
            assert!(parse_icp_registration(Some(input)).is_err());
        }
    }
    #[test]
    fn local_bootstrap_requires_loopback_listener_and_public_origin() {
        assert!(loopback_addresses(
            "127.0.0.1:8810",
            "http://localhost:8810"
        ));
        assert!(loopback_addresses("[::1]:8810", "http://[::1]:8810"));
        for (bind, url) in [
            ("0.0.0.0:8810", "http://localhost:8810"),
            ("127.0.0.1:8810", "https://zhihui.helms.wiki"),
            ("[::]:8810", "http://localhost:8810"),
            ("127.0.0.1:8810", "http://localhost.evil.invalid"),
        ] {
            assert!(!loopback_addresses(bind, url));
        }
    }
}
