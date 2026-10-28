# 知会 Web 0.6.6

独立的浏览器版，产品版本保持 **0.6.6**，当前 Web 构建号为 **5**（包含 LOGO 显示修复与可配置备案页脚）。历史 `0.6.6-web.1` Docker 镜像仍是旧代码，部署时必须使用与当前构建号一致并完成验证的制品。桌面源码、依赖、Cargo workspace、迁移、安装包和更新地址均不因本工程改变。

Web 支持受邀账号、会议搜索与管理、麦克风实时转写、音频/文字/DOCX/文字型 PDF 导入、说话人编辑、模板纪要、BlockNote 编辑，以及 PDF/DOCX/Markdown/TXT 导出。语音功能取决于所选服务返回的能力；Token Plan 采用文件转写方案，不支持边录边转写或自动说话人分离。会议存储在当前服务器，与桌面本机会议独立。

## 运行

需要 Node.js 20、pnpm 8.15.9、Rust 1.90 或以上，以及 `ffmpeg`/`ffprobe`。所有命令均在本仓库内执行。现有桌面开发终端可继续用于桌面；本工程有独立锁文件和输出目录。

已完成私人初始化的本机预览从仓库根目录启动：

```powershell
powershell -NoProfile -File web/scripts/preview-local.ps1
```

打开 [本机预览](http://127.0.0.1:18810)。脚本读取 `baseline.json` 的构建号（当前为 2），复用已构建的前端、服务端及 FFmpeg 工具；不创建或重置账号。账号与会议保存在 Git 忽略的 `web/.runtime/local/data`，主密钥另存于同级 `secrets`，本机权限仅授予当前用户和 SYSTEM。重启保留个人配置；不要把该运行目录复制到生产。

下列命令用于独立初始化常规开发或生产数据目录：

```powershell
cd web/frontend
pnpm install --frozen-lockfile
pnpm build

cd ../server
$env:ZHIHUI_DATA_DIR = './data'
$env:ZHIHUI_MASTER_KEY_FILE = './secrets/master_key'
$env:ZHIHUI_STATIC_DIR = '../frontend/out'
$env:ZHIHUI_PUBLIC_URL = 'http://localhost:8810'
cargo run --locked -- init-key
```

首次启动创建管理员。密码从标准输入读取，不放进命令参数或源码：

```powershell
$webPassword = Read-Host '设置 Web 管理员密码（至少 12 个字符）' -AsSecureString
$webPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($webPassword)
try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($webPasswordPointer) |
        cargo run --locked -- create-admin --username admin
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($webPasswordPointer)
    $webPassword.Dispose()
}
cargo run --locked -- serve
```

打开 [本机知会 Web](http://localhost:8810)，在“设置 → 账号与访问”生成一次性邀请链接。每个用户在“模型与 API”分别配置自己的语音与摘要地址、模型和 Key；新用户的 Key 为空，不继承管理员凭据。常规初始化没有预设密码或 Key，密码至少 12 个字符。仅私人本机初始化可显式使用 `create-admin --username admin --local-bootstrap`，允许至少 8 个字符；监听地址和公开 Origin 都必须是回环地址。该账号标记为 `local_password_exception`，存在此标记的数据目录会拒绝以公网配置启动 `serve`。

支持的模型配置如下，地址必须精确匹配官方白名单，不能填写任意服务器：

| 服务 | 语音 | 摘要 |
| --- | --- | --- |
| 百炼北京 | `https://dashscope.aliyuncs.com`；实时 `qwen3-asr-flash-realtime`，文件 Paraformer-v2（说话人分离） | `https://dashscope.aliyuncs.com/compatible-mode/v1`；默认 `qwen-plus` |
| Token Plan | 设置地址仍为 `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`；`qwen-audio-3.0-asr-flash`，同主机原生文件转写，最多 5 分钟、10MB；无实时转写或自动说话人分离 | 同一设置地址；`qwen3.8-flash`，OpenAI 兼容协议 |

用户已批准“语音使用同一服务的原生接口，摘要使用 OpenAI 兼容接口”。Token Plan 文件 ASR 由服务端将私有 FLAC 以 Base64 交给同主机的 `multimodal-generation` 接口，不开放任意地址或公共录音链接；10MB 按 10,000,000 字节限制，时长同时受服务器上限约束，当前使用自动语言识别。build 2 已完成本机真实音频上传、FLAC 转换、指定语音模型识别及摘要任务验证，重启后配置和已完成任务保留，同请求编号返回原任务。页面以 `GET /settings` 的 ASR `capabilities` 为准；可导入已录好的音频，说话人可手工编辑。此验证不代表已发布云端镜像或验证所有语言与音质。

开发时可以在另一个终端运行 `web/frontend` 下的 `pnpm dev`，页面端口为 3120，API 由 Next 开发代理转发至 8810。此时 Rust 终端必须设置 `ZHIHUI_PUBLIC_URL=http://localhost:3120`，使写请求的 Origin 校验与浏览器地址一致。生产运行只需要静态文件与 Rust 服务，不运行 Next 开发服务器。

## 与桌面保持一致

`baseline.json` 固定已发布 0.6.6 的 510 个源码指纹，并补充保护 PDF 导出的两个字体文件。前端来源文件和服务端模板均有映射。Web 改动仅发生在副本中；桌面路径始终只读。

```powershell
# 检查桌面输入、Web/服务端版本和经过复核的覆盖文件
node web/scripts/baseline.mjs verify

# 代码复核后记录 Web 适配差异；桌面输入变化时此命令拒绝运行
node web/scripts/baseline.mjs review

# 未来桌面正常发版：只生成 Web 目录内的待合并文件和冲突报告
node web/scripts/baseline.mjs stage

# 手动合并、检查冲突后推进基线；再对齐 Web 版本、验收并 review/verify
node web/scripts/baseline.mjs accept
```

同步不会自动覆盖 Web 已适配的文件，也不会写入桌面。上游有新文件、旧文件变更、删除或覆盖文件未经复核时，发布必须停止。`src/desktop-reference` 是未加载的原生页面参考；浏览器入口和适配器在 `frontend/src/app`、`frontend/src/web`，生产包不包含 Tauri。

同一产品版本表示对齐的会议工作流与模板，不承诺不同语音/摘要模型逐字输出一致。Web 使用云 API；桌面继续使用原有本地模型。浏览器共享音频、系统权限及页面生命周期存在平台限制；中断后保留服务端已接收的录音和转写，不能保证浏览器关闭后继续采集。

## 验证

```powershell
node --test web/tests/baseline.test.mjs
node web/scripts/check-native-deps.mjs
cargo test --locked --manifest-path web/server/Cargo.toml

cd web/frontend
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`web/tests/api-smoke.mjs` 启动独立本机 Rust 进程、真实 SQLite 和模拟百炼 HTTP 接口，完成两个账号、上传/媒体检查、Range、转写、重启恢复、摘要、编辑及备份的闭环：

```powershell
cargo build --locked --manifest-path web/server/Cargo.toml
$env:ZHIHUI_FFPROBE = 'ffprobe' # 或测试工具的完整路径
$env:ZHIHUI_FFMPEG = 'ffmpeg'
node web/tests/api-smoke.mjs
```

测试数据只写入 `web/.test-data`，报告不包含密码或 Key。该测试不调用真实收费模型，不能代替真实 Key 下的识别准确率、额度、延迟和计费验收。Rust 集成测试另覆盖模拟 WebSocket 实时转写、取消竞争、邀请单次使用、凭据认证加密和任务提交边界。

## 部署与发布

详见 [部署手册](DEPLOY.md)、[服务端说明](server/README.md) 和 [接口约定](API.md)。默认发布模式为 WebOnly，沿用已有 0.6.6 桌面安装包及其 SHA-256，不写桌面更新清单。未来 Paired 模式通过显式传入的既有桌面脚本协调双端发布，不修改那些脚本。

用户已确认 `helms.wiki` 备案审核通过。正式接入 `https://zhihui.helms.wiki` 前仍需核实 DNS、实际备案接入信息、HTTPS、服务器依赖和云端验收。生产目录的独立 `.env.site` 可设置真实 `ZHIHUI_ICP_NUMBER`，登录页和主界面底部会显示链接到工信部备案系统的文本；未提供编号时隐藏，不能填写虚构编号。该文件与每次发布生成的 `.env` 分开，stage/activate/rollback 不覆盖已有站点配置。服务器数据、加密主密钥、备份和制品均不提交 Git。生产只运行单实例；首次上线后保存主密钥的独立安全副本，不能通过重新生成主密钥恢复已加密的 Key。
