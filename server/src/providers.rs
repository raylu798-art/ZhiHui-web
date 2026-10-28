//! Per-user, allowlisted provider settings. Credentials and routing are read in one SQLite snapshot.
use crate::{
    crypto,
    error::{ApiError, Result},
    state::App,
};
use serde::Serialize;

pub const TOKEN_PLAN_BASE: &str = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";
pub const TOKEN_PLAN_ASR_ENDPOINT:&str="https://token-plan.maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation";
pub const TOKEN_PLAN_AUDIO_LIMIT: u64 = 10_000_000;
pub const DASHSCOPE_ASR_BASE: &str = "https://dashscope.aliyuncs.com";
pub const DASHSCOPE_SUMMARY_BASE: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Dashscope,
    TokenPlan,
}
#[derive(Clone, Serialize, Debug)]
pub struct AsrCapabilities {
    pub file_transcription: bool,
    pub realtime: bool,
    pub diarization: bool,
    pub max_duration_seconds: u64,
}
#[derive(Clone, Debug)]
pub struct Profile {
    pub provider: Provider,
    pub base_url: String,
    pub model: String,
    pub capabilities: AsrCapabilities,
}
pub struct UserProvider {
    pub profile: Profile,
    encrypted: Option<String>,
}
impl UserProvider {
    pub fn credential(&self, state: &App, uid: &str, purpose: &str) -> Result<String> {
        let encrypted = self
            .encrypted
            .as_ref()
            .ok_or_else(|| ApiError::bad("请先在设置中配置 API Key"))?;
        crypto::decrypt(&state.key, &format!("{uid}:{purpose}"), encrypted).map_err(Into::into)
    }
    pub fn settings_json(
        &self,
        state: &App,
        uid: &str,
        purpose: &str,
    ) -> Result<serde_json::Value> {
        let key = self
            .encrypted
            .as_ref()
            .map(|_| self.credential(state, uid, purpose))
            .transpose()?;
        let masked = key
            .as_ref()
            .map(|key| {
                let tail: String = key
                    .chars()
                    .rev()
                    .take(4)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                format!("********{tail}")
            })
            .unwrap_or_default();
        let mut value = serde_json::json!({"provider":self.profile.provider,"base_url":self.profile.base_url,"model":self.profile.model,"configured":key.is_some(),"key_masked":masked,"region":"beijing"});
        if purpose == "asr" {
            value["capabilities"] =
                serde_json::to_value(&self.profile.capabilities).expect("capabilities serialize");
            if self.profile.provider == Provider::TokenPlan {
                value["protocol"] = serde_json::json!("dashscope_native");
            }
        }
        Ok(value)
    }
}
pub fn resolve(
    purpose: &str,
    base: Option<&str>,
    model: Option<&str>,
    max_seconds: u64,
) -> Result<Profile> {
    let default_base = if purpose == "asr" {
        DASHSCOPE_ASR_BASE
    } else {
        DASHSCOPE_SUMMARY_BASE
    };
    let base = base.unwrap_or(default_base);
    let provider = if base == TOKEN_PLAN_BASE {
        Provider::TokenPlan
    } else if base == default_base {
        Provider::Dashscope
    } else {
        return Err(ApiError::bad(
            "仅允许受支持的官方服务地址，不接受自定义主机、端口或查询参数",
        ));
    };
    let default_model = match (purpose, provider) {
        ("asr", Provider::TokenPlan) => "qwen-audio-3.0-asr-flash",
        ("asr", Provider::Dashscope) => "qwen3-asr-flash-realtime",
        (_, Provider::TokenPlan) => "qwen3.8-flash",
        _ => "qwen-plus",
    };
    let model = model.unwrap_or(default_model);
    let allowed = match (purpose, provider) {
        ("asr", Provider::TokenPlan) => model == "qwen-audio-3.0-asr-flash",
        ("asr", Provider::Dashscope) => model == "qwen3-asr-flash-realtime",
        (_, Provider::TokenPlan) => model == "qwen3.8-flash",
        _ => ["qwen-plus", "qwen-turbo", "qwen-max"].contains(&model),
    };
    if !allowed {
        return Err(ApiError::bad("该服务地址不支持所选模型"));
    }
    let enabled = provider == Provider::Dashscope;
    Ok(Profile {
        provider,
        base_url: base.into(),
        model: model.into(),
        capabilities: AsrCapabilities {
            file_transcription: true,
            realtime: enabled,
            diarization: enabled,
            max_duration_seconds: if enabled {
                max_seconds
            } else {
                max_seconds.min(300)
            },
        },
    })
}
pub async fn load(state: &App, uid: &str, purpose: &str) -> Result<UserProvider> {
    let pool = state.user_db(uid).await?;
    let (base,model,encrypted):(Option<String>,Option<String>,Option<String>)=sqlx::query_as("SELECT (SELECT value FROM settings WHERE key=?),(SELECT value FROM settings WHERE key=?),(SELECT encrypted FROM credentials WHERE purpose=?)")
        .bind(format!("{purpose}_base_url")).bind(format!("{purpose}_model")).bind(purpose).fetch_one(&pool).await?;
    Ok(UserProvider {
        profile: resolve(
            purpose,
            base.as_deref(),
            model.as_deref(),
            state.config.max_seconds,
        )?,
        encrypted,
    })
}
pub fn summary_endpoint(state: &App, profile: &Profile) -> String {
    match profile.provider {
        Provider::TokenPlan => format!("{}/chat/completions", profile.base_url),
        Provider::Dashscope => format!(
            "{}/compatible-mode/v1/chat/completions",
            state.config.provider_base
        ),
    }
}
pub fn require_file_asr(profile: &Profile) -> Result<()> {
    if profile.capabilities.file_transcription {
        Ok(())
    } else {
        Err(ApiError::bad(
            "当前语音服务尚未启用文件转写协议，请先选择支持的语音服务",
        ))
    }
}
pub fn require_realtime_asr(profile: &Profile) -> Result<()> {
    if profile.capabilities.realtime {
        Ok(())
    } else {
        Err(ApiError::bad(
            "当前语音服务不支持实时转写，请先选择支持的语音服务",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_allowlist_models_and_token_plan_capabilities() {
        let profile = resolve(
            "asr",
            Some(TOKEN_PLAN_BASE),
            Some("qwen-audio-3.0-asr-flash"),
            7200,
        )
        .unwrap();
        assert_eq!(profile.provider, Provider::TokenPlan);
        assert!(profile.capabilities.file_transcription);
        assert!(!profile.capabilities.realtime);
        assert!(!profile.capabilities.diarization);
        assert_eq!(profile.capabilities.max_duration_seconds, 300);
        assert!(require_file_asr(&profile).is_ok());
        assert!(require_realtime_asr(&profile).is_err());
        assert!(resolve(
            "summary",
            Some(TOKEN_PLAN_BASE),
            Some("qwen3.8-flash"),
            7200
        )
        .is_ok());
        assert!(resolve("summary", Some(TOKEN_PLAN_BASE), Some("qwen-plus"), 7200).is_err());
        for base in [
            "http://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
            "https://token-plan.maas.qianwenaiapi.com:443/compatible-mode/v1",
            "https://user@token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
            "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1?x=1",
            "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1#x",
            "http://127.0.0.1:9999",
            "https://evil.invalid/compatible-mode/v1",
        ] {
            assert!(
                resolve("summary", Some(base), Some("qwen3.8-flash"), 7200).is_err(),
                "accepted {base}"
            );
        }
        let legacy = resolve("asr", None, None, 7200).unwrap();
        assert!(
            legacy.capabilities.realtime
                && legacy.capabilities.file_transcription
                && legacy.capabilities.diarization
        );
        assert_eq!(legacy.model, "qwen3-asr-flash-realtime");
    }
}
