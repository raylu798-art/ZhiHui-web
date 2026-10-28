# ZhiHui Web server 0.6.6

Independent Rust/Axum service; no Tauri, native inference, desktop migrations, or desktop database access. Build with Rust 1.90 or newer; locked dependencies require up to Rust 1.89. `Cargo.lock` belongs to this crate's own workspace. The version remains **0.6.6**, with `ZHIHUI_BUILD` distinguishing Web rebuilds. Run one server process per data volume; the two durable job workers enforce one file-ASR and one summary task site-wide. Do not scale replicas against this SQLite volume.

Current source is **Web build 5**, including account/provider configuration, the Logo fix, and optional public ICP metadata. Use a newly verified build 5 artifact for deployment; the historical build 1 Docker image does not contain these changes.

## Local start

After private local initialization and building the frontend/server, run `powershell -NoProfile -File web/scripts/preview-local.ps1` from the repository root. It serves `http://127.0.0.1:18810`, reads the build number from `baseline.json` (currently 4), and reuses persistent, Git-ignored `web/.runtime/local/data`. The master key is outside data, in `.runtime/local/secrets`, with Windows ACL access limited to the current user and SYSTEM. The script requires existing binaries/tools/key and does not create credentials or reset the account. Do not copy this personal runtime directory to production.

For a separately initialized development or production directory:

```powershell
# Run from web/server. Use disposable paths for development; never point at desktop data.
$env:ZHIHUI_DATA_DIR = './data'
$env:ZHIHUI_MASTER_KEY_FILE = './secrets/master_key'
$env:ZHIHUI_PUBLIC_URL = 'http://localhost:8810'
$env:ZHIHUI_STATIC_DIR = '../frontend/out'
cargo run --locked -- init-key
# Read a password from a secret source or private stdin; do not put it in argv/history.
# <password-stdin> | cargo run --locked -- create-admin --username admin
cargo run --locked -- serve
```

The `create-admin --username NAME` command consumes a 12–256 character password from stdin. It creates a new account and fails on a duplicate name. `invite --days 7` prints a single-use link as JSON; treat the output as a secret. Invitations are valid for at most 30 days. The admin UI can invite and disable users. Cookie sessions expire after seven days; disabling a user immediately invalidates all their sessions and provider grants.

Only private local initialization may explicitly use `create-admin --username admin --local-bootstrap`, still with password stdin. This permits 8–256 characters for `admin`, requires both bind and public origin to be loopback, and saves a `local_password_exception` marker. `serve` refuses a public configuration while any account has that marker. Regular administrator/invited-user passwords remain 12–256 characters. Production initialization has no preset password or Key and must use the regular command.

`ffprobe` and `ffmpeg` must be on PATH (Docker installs both). Uploads are stream-limited and media-probed with an explicit file/pipe protocol and audio/container demuxer allowlist. Supported files: WAV, MP3, M4A/MP4, FLAC, OGG, WebM, AAC. The HTTP API accepts no user-specified executable, server path, arbitrary command, or arbitrary provider endpoint; model configuration is limited to the exact official addresses below.

## Configuration

| Environment variable | Default |
| --- | --- |
| `ZHIHUI_BIND` | `127.0.0.1:8810` |
| `ZHIHUI_PUBLIC_URL` | `http://localhost:8810` (exact browser origin) |
| `ZHIHUI_ICP_NUMBER` | unset (optional public registration text, trimmed, at most 100 characters, no control characters) |
| `ZHIHUI_DATA_DIR` | `./data` |
| `ZHIHUI_STATIC_DIR` | `../frontend/out` |
| `ZHIHUI_MASTER_KEY_FILE` | `./secrets/master_key` (outside data directory) |
| `ZHIHUI_BUILD` | `2` (preview/release set it from `baseline.json`) |
| `ZHIHUI_MAX_UPLOAD_BYTES` | `209715200` |
| `ZHIHUI_USER_QUOTA_BYTES` | `5368709120` |
| `ZHIHUI_MAX_AUDIO_SECONDS` | `7200` |
| `ZHIHUI_REALTIME_LIMIT` | `2` (one per user) |
| `ZHIHUI_FFPROBE` | `ffprobe` |
| `ZHIHUI_FFMPEG` | `ffmpeg` |
| `ZHIHUI_CONVERT_TIMEOUT_SECONDS` | `600` (30–3600) |
| `ZHIHUI_POLL_SECONDS` | `3` |
| `ZHIHUI_DASHSCOPE_BASE` | `https://dashscope.aliyuncs.com` |
| `ZHIHUI_DASHSCOPE_REALTIME_URL` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` |

Production must use HTTPS and the exact public origin. Cookies become Secure automatically on HTTPS. All writes and WebSocket handshakes require that origin; there is no permissive CORS. Reverse proxies must pass the browser Origin and WebSocket headers. `/api/v1/health` checks SQLite and returns version/build. `/health` is an alias. No request URI is logged because invitation and provider links carry bearer tokens. Do not enable proxy logs containing those URLs.

Environment endpoint overrides remain deployment-only configuration for DashScope transport or loopback mock tests. Per-user HTTP settings separately accept `asr_base_url`, `asr_model`, `summary_base_url`, and `summary_model`. The only bases are DashScope ASR `https://dashscope.aliyuncs.com`, DashScope summary `https://dashscope.aliyuncs.com/compatible-mode/v1`, and the fixed official Token Plan base `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`. Alternate ports, userinfo, queries, fragments, and custom hosts are rejected. Change the base and model together when switching providers. If a Key is already saved, changing its base also requires the new service's Key in that same request, or explicit deletion of the old credential first; an old Key is never silently reused on a different host. Region remains `beijing`.

DashScope selects ASR `qwen3-asr-flash-realtime` and summary `qwen-plus` (also `qwen-turbo`/`qwen-max`). Token Plan selects ASR `qwen-audio-3.0-asr-flash` and summary `qwen3.8-flash`. The user approved native ASR on that same host, with summaries continuing over OpenAI-compatible `/chat/completions`. The stored provider base remains `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`; the fixed native ASR endpoint is `https://token-plan.maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation`, not an arbitrary client URL.

Build 2 Token Plan ASR submits private mono16kHz FLAC as Base64, limited before billing to 5 minutes / 10,000,000 audio bytes. It supports completed-file transcription with automatic language detection, without automatic speaker diarization or real-time streaming; manual speaker editing remains available. Non-`auto` language requests are rejected with an explicit message. ASR capabilities are `file_transcription=true`, `realtime=false`, `diarization=false`, and `max_duration_seconds=min(300,server_limit)`. `GET /settings` reports each purpose's `provider`, `base_url`, `model`, `configured`, and masked Key; ASR also reports capabilities and `protocol="dashscope_native"`. The full response text is saved as one transcript without inferred segment timestamps or speakers. An authorized local end-to-end check uploaded public `welcome.mp3`, converted it to FLAC, and completed with “欢迎使用阿里云。”; a real summary also completed. Terminal retries and retries after server restart returned the same jobs without new provider submissions. Real-time support remains disabled.

Every user's routing/model/Key is independent, read in one SQLite snapshot, and new users start without Keys. API Keys use AES-256-GCM with random nonces and user/purpose authenticated context. The 32-byte master key is a separate file (raw bytes or base64), excluded from backups. Startup verifies that existing credentials decrypt; never replace a deployed key. Passwords use Argon2id; only two password operations run concurrently. Session and invitation bearer tokens are stored as SHA-256 hashes.

## Jobs, recordings, and limits

- `POST /jobs` requires a client-generated `request_id` UUID. Retain the UUID and original payload across a lost/uncertain HTTP response. A per-user durable mapping returns the original job after completion or restart, before checking mutable settings or credentials; a different payload with the same UUID returns 409. A new deliberate task gets a fresh UUID. The mapping and queued job commit in one `BEGIN IMMEDIATE` transaction, so concurrent identical requests cannot enqueue multiple paid tasks. Hashes use the originally submitted kind/meeting/asset/template/language values, not resolved defaults.
- DashScope file ASR: Paraformer-v2 with speaker diarization. Before any paid POST, FFmpeg mixes all channels of the first audio stream into a private 16kHz mono FLAC; a stereo participant on either channel is retained. The original meeting audio remains unchanged. Conversion has one encoding/filter thread, protocol/demuxer allowlists, allocation limits, duration/byte/quota bounds, timeout and cancellation. Truncated/invalid output never reaches the provider. A random, 24-hour, job-bound URL exposes only this derivative. Its ownership link is persisted before submission and retained across polling restarts; terminal jobs revoke the link and remove the derivative. Startup removes cancelled/terminal orphan derivatives and partial files. A lost response after a paid POST becomes interrupted with an explicit possible-billing warning.
- Token Plan file ASR uses the approved native Base64 protocol above, not a public provider-download link. Its 5-minute / 10MB limits must be checked before billing. A completed browser recording may enter this file flow; it cannot use the real-time WebSocket flow.
- A durable `submission_started` boundary precedes chargeable requests. If the server restarts after submission but before receiving/storing an upstream ID, the job becomes **interrupted**, never automatically resubmitted. Operators/users should inspect the provider console before a manual retry. A persisted upstream ID resumes polling after restart. Summary jobs interrupted by restart need manual retry; incomplete outputs never replace saved minutes.
- Cancellation is local and immediately suppresses late results. An upstream task that was already accepted may still be billed. Old transcripts are replaced only in a successful transaction; previous rows remain in private `transcript_revisions` for recovery. The first UI exposes the active transcript, not a version browser.
- Summaries use the selected per-user provider/model (default Qwen-Plus, Token Plan `qwen3.8-flash`) and the desktop's seven copied templates and template-to-prompt processing. Large transcripts are summarized in chunks before the final report; output is Chinese Markdown. This is a cloud-provider adaptation, so wording/output differs from local desktop models.
- DashScope real-time ASR: Qwen3-ASR-Flash-Realtime, server VAD, PCM16 mono at 16kHz. Binary frames ≤64KiB; `{ "type":"stop" }` finishes the provider session and waits for the final transcript. The service writes a recoverable WAV while streaming. Disconnect, provider error, or restart preserves received audio/transcripts and marks interrupted; it never reconnects a billable session automatically. Token Plan real-time ASR is disabled.
- Upload and real-time recording must meet **both** the byte and duration limits. At 16kHz PCM, 200MiB limits a continuous recording to about 109 minutes, earlier than the two-hour ceiling. Per-user uploads/recording file writes are serialized to enforce the quota. One account can queue at most 20 tasks.
- SSE notifications are user-filtered hints; REST is authoritative and supports refresh recovery. The browser may poll instead. Browser system audio capture depends on `getDisplayMedia` support and permissions; this service has no access to the desktop's system audio.

## Backup and verification

```sh
zhihui-web backup --output /backup/backup-20261021T120000Z
cargo test --locked
cargo check --locked
```

Backup refuses an existing destination and any destination inside the data directory. Each database is copied using SQLite `VACUUM INTO` while online and checked with `PRAGMA integrity_check`. Registered audio assets (including an active provider derivative) and in-flight recording references are both read from that database snapshot, so a recording completing during backup cannot lose its WAV reference. A missing registered asset fails the backup. `manifest.json` contains every copied file's SHA-256 and size. It excludes the encryption key and transient WAL/SHM files. Snapshots are individually consistent, not a single cross-database transaction; restore with the service stopped and verify the manifest first. Retain the original master key separately or stored API Keys cannot be recovered. A failed backup may leave an incomplete output directory; it must never be used for restoration. Existing development Web databases receive a verified online snapshot and SHA-256 file before adding a missing provider-asset or job-request table; the desktop schema is never read or changed.

The build 2 verification passed `cargo fmt --check`, `cargo check --locked --jobs 2`, `cargo build --locked --jobs 2`, and all **22 Rust tests** (10 unit, 12 integration), using available FFmpeg/FFprobe. Tests use temporary databases, dummy Keys and mock providers only. They cover invited-user authentication, single-use invites, origin checks, ownership isolation, private templates/credentials, hashed sessions, encryption context, backup integrity and recording-completion races, NULL/empty speaker renaming, durable request idempotency after completion/restart, key collision/user isolation/concurrent retries, restart boundaries, persisted upstream ID polling, transactionally replacing transcripts with retained revisions, authenticated HTTP Range, provider-link revocation, cancellation while a billable submission is in flight, and a real WebSocket PCM-to-transcript-to-WAV round trip. A real stereo fixture checks that both channels survive conversion, private derivatives resume and back up correctly, quota failure precedes billing, and terminal cleanup retains the original audio. Added tests verify the exact provider/model allowlist, atomic per-user routing and credential isolation, host-switch Key replacement, explicit local password exception and public-listener refusal, native duration/size boundaries, full-text parsing, actual FLAC inline request shape and pre-request durable marker, one submission across unknown-response restart, and suppression of cancelled late results. Media conversion tests require available FFmpeg/FFprobe (or explicit environment paths); they print a skip reason when unavailable. Production DNS/TLS remains to be verified separately.

Provider protocol references: [Paraformer HTTP API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api), [Qwen-ASR client events](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-realtime-client-events), [Qwen-ASR server events](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events), [Qwen-ASR SDK/endpoint compatibility](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-python-sdk).
