# ZhiHui Web 0.6.6 部署与发布

所有新文件都在 `web/`。首次发布只上线 Web，沿用现有桌面 0.6.6 安装包与更新清单；不访问许可证数据库、不重启许可证进程、不覆盖旧 Nginx 配置。以下命令是部署操作手册，本次实现不会自动执行服务器安装、DNS 或公网发布。

当前源码为产品 **0.6.6 / Web build 5**，包含个人账号、Token Plan、LOGO 和可配置备案页脚。已归档的 `0.6.6-web.1` 是历史制品，仍保留旧代码；不能将其当作 build 5 发布。发布当前源码应重新执行完整 release 验证并生成独立的 `0.6.6-web.5` 目录，下文上线命令以此构建号为准。用户已确认 `helms.wiki` 备案审核通过，备案号需写入运行时配置，DNS 和证书管理邮箱需核实；是否已完成公网接入以本轮部署验收记录为准。

本机使用 `powershell -NoProfile -File web/scripts/preview-local.ps1`，默认仅监听 `127.0.0.1:18810`，持久目录为 Git 忽略的 `web/.runtime/local`。主密钥在 data 外，Windows ACL 仅当前用户和 SYSTEM 可访问。该目录的私人 `admin` 可通过显式 `--local-bootstrap` 采用至少 8 字符的本机例外；服务检查回环监听和 Origin，并拒绝将含 `local_password_exception` 标记的数据库以公网配置启动。不要上传该目录；生产仍独立初始化、密码至少 12 字符，不预置账号口令或 API Key。

## 1. 构建与发布制品

在仓库根目录执行，要求 Node 20、pnpm 8.15.9、Rust、运行中的 Docker Linux Engine：

```powershell
powershell -NoProfile -File web/scripts/release.ps1 -DryRun
powershell -NoProfile -File web/scripts/release.ps1
```

脚本先验证桌面基线，再冻结安装并生产构建独立 Web 前端、执行 `cargo test --locked`，最后在本地构建 Linux/amd64 多阶段镜像。2C2G 服务器只加载并运行镜像。产物目录由产品版本与 `webBuild` 决定，当前为 `web/artifacts/0.6.6-web.5/`，包含 `image.tar`、`compose.yml`、`release-manifest.json`。清单包含源码内容指纹、Docker image ID、归档 SHA-256、桌面安装包引用和 SHA-256、数据库版本。发布目录不可覆盖；Web 修复先增加 `baseline.json` 的 `webBuild`，产品版本仍为 0.6.6。

基础镜像默认来自 Docker Hub。网络无法访问时可显式设置 `-BaseRegistry mirror.gcr.io`（[Google 官方 Docker Hub 缓存](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images)）或 `-BaseRegistry public.ecr.aws/docker`（[AWS Public Gallery](https://gallery.ecr.aws/) 中 Docker Official Images）；这只影响本次构建，不修改 Docker 全局代理或镜像配置。清单记录所用 registry 和最终不可变 image ID。禁止换成未经核对的第三方镜像源。

默认桌面引用是 `_build-tools/updater/publish/0.6.6/Zhihui_0.6.6_x64-setup.exe`，校验已发布 SHA-256 `579ca480d6fba67372715c307750879d5e800ecf7aa6fb110282f23dcac8106e`。初次发布不重建桌面，不写任何 `latest.json`。不要上传整个仓库、`.env`、源数据库或密钥；Docker 构建上下文有单独排除规则。

未来桌面正常发版时，先按 Web 基线工具完成来源变更复核，再显式使用 `release.ps1 -Mode Paired -DesktopBuildScript <既有构建入口> -DesktopArtifact <新安装包>`。外层脚本仅调用该入口，不修改入口。双端发布要求两个制品验证均通过；发布桌面安装包仍使用既有渠道。`release-activate.ps1` 的 Paired 模式要求显式提供既有的 `-DesktopPublishScript` 和 `-DesktopRollbackScript`：Web 候选验证、Web 切换、HTTPS 健康验证通过后，最后运行桌面发布入口。桌面入口必须原子更新清单，回滚入口必须恢复旧清单；任一步失败，调用桌面回滚并回滚 Web。首次 WebOnly 不接受桌面发布参数。没有全局跨服务器原子事务，切换窗口会短暂存在两个版本；同批次成功以两端回执为准。

构建清单保留构建机的 `imageId`，并从导出的 TAR 中唯一匹配镜像标签的原始 config JSON 字节计算 `imageConfigId`。`image-identity.mjs` 以文件偏移跳过层数据，限制 metadata 大小，拒绝重复成员、链接、路径逃逸及不一致的平台/源码/版本标签，不将整个镜像加载进内存。部署验证完整归档 SHA-256、原始 config、源码与版本标签后，才接受运行引擎返回这两个内容标识之一，以兼容 Docker 29/containerd 与 Docker 26/经典存储的 ID 表示差异。不得手改历史归档清单或跳过身份检查；build 4 保持不可变，后续使用 build 5。

## 2. 阿里云首次准备（操作前先复核）

目标为现有 Alibaba Cloud Linux 3 x86_64，公网 IP `101.200.125.86`。只读检查时，约 1870 MiB 内存、1521 MiB 可用、磁盘剩余 32 GiB，尚未安装 Docker/Nginx；80、443、8810 未占用。实际安装前重新执行 `free -m`、`df -h`、`ss -lntp`，至少为 Web 留出 1.3 GiB 可用内存及 5 GiB 磁盘。许可证健康接口应先记录成功结果：

```bash
curl --fail http://127.0.0.1:8801/api/v1/health
free -m
df -h /opt
ss -lntp
```

通过域名控制台添加 `zhihui` A 记录到该服务器；没有配置 IPv6 服务时不要添加 AAAA。确认域名实际解析、阿里云接入备案和所需公安备案状态；大陆节点上线须满足实际接入要求。[阿里云备案说明](https://help.aliyun.com/en/icp-filing/basic-icp-service/support/for-the-record-process-faq)。安全组只按需要开放 80/443，保留现有 SSH 和许可证端口规则；8810 和候选端口 18810 始终仅绑定回环。不要清空防火墙、修改旧许可证端口或停用 SELinux。

按阿里云当前 [Docker 安装指南](https://help.aliyun.com/en/ecs/user-guide/install-and-use-docker) 安装 Docker CE、buildx、Compose 插件（Alibaba Cloud Linux 3 需要 `dnf-plugin-releasever-adapter --repo alinux3-plus`）；安装 Nginx、Python 3.9 或更新版本、openssl、curl、util-linux。备份当前包清单、Nginx 配置和防火墙规则后，由管理员执行安装：

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
sudo dnf -y install dnf-plugin-releasever-adapter --repo alinux3-plus
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nginx openssl curl util-linux
sudo systemctl enable --now docker
docker compose version
python3 --version
```

若 `python3` 低于 3.9，先按系统软件源安装受支持的 Python 3.9+，并将 `deploy.sh`、`backup.sh` 的 `python3` 调用明确改为该解释器。Docker 会配置自身桥接网络规则，安装后立即复查许可证健康和原有访问规则；本项目脚本不重写系统防火墙。Nginx 首次启动前审查现有站点，保留默认站点与其他应用。

上传 `web/deploy/` 内的运维文件到独立目录 `/opt/zhihui-web/`，上传发布目录到 `/opt/zhihui-web/releases/0.6.6-web.5/`。使用 SSH/SFTP 信任过的主机指纹，禁止关闭 `StrictHostKeyChecking`。脚本由自身位置推导目录；如更换目录，同步修改两个 systemd 备份单元的路径。

```bash
cd /opt/zhihui-web
chmod 700 deploy.sh backup.sh
install -d -m 700 secrets releases staging
install -d -o 10001 -g 10001 -m 700 data backups
# 仅首次生成；已存在时退出，不可覆盖，否则保存的 API Key 无法解密。
test ! -e secrets/master_key || exit 1
(umask 077; openssl rand -base64 32 > secrets/master_key)
chown root:10001 secrets/master_key
chmod 440 secrets/master_key
./deploy.sh preflight
```

主密钥独立只读挂载，API Key 密文在各用户存储里。将主密钥单独保存到离线受控备份，禁止与数据备份打成同一归档。Compose 使用 UID/GID 10001、只读根文件系统、1 GiB 内存上限、有限 tmpfs/日志；不共享许可证数据卷。[Compose 资源与 secret 行为](https://docs.docker.com/reference/compose-file/services/)。若 SELinux 拒绝访问，只针对新增目录设置容器可用标签并按 audit 日志验证，不要全局关闭。

站点公开信息单独保存在 `/opt/zhihui-web/.env.site`。`deploy.sh preflight/stage/activate` 会在缺失时创建空文件，不覆盖已有文件；每次发布重写的 `.env` 仍只保存镜像与构建号。确认真实备案号后，以单行 `ZHIHUI_ICP_NUMBER=` 后接实际完整编号写入 `.env.site`（不写任何密码或 API Key），保持文件为普通文件而非符号链接，随后重新创建 app 容器使环境生效。Compose 通过 `env_file` 加载它；直接运行 Compose 前也要先准备该文件。编号会出现在公共 `GET /api/v1/version` 的 `icp_registration` 中，登录页及主界面页脚使用固定工信部链接展示。空值隐藏，最多 100 个字符，不接受控制字符，不生成或推测备案号。候选 stage 同样加载站点信息，以便上线前检查。

## 3. HTTPS、候选验证与上线

首先仅启用 HTTP 的 ACME 站点（保存为新的 `/etc/nginx/conf.d/zhihui-web.conf`；文件已存在时先人工审查，不可直接覆盖）：

```nginx
server {
    listen 80;
    server_name zhihui.helms.wiki;
    location ^~ /.well-known/acme-challenge/ { root /var/lib/zhihui-web-acme; }
    location / { return 503; }
}
```

创建 webroot、`nginx -t`，再启动/重载 Nginx。先用 `certonly --dry-run` 验证域名挑战，再去掉 `--dry-run` 申请真实证书；`<管理邮箱>` 用于续期通知，不放在源码中：

```bash
install -d -m 755 /var/lib/zhihui-web-acme /etc/letsencrypt
nginx -t
systemctl enable --now nginx
docker pull certbot/certbot:v5.8.0
docker run --rm \
  --mount type=bind,src=/etc/letsencrypt,dst=/etc/letsencrypt \
  --mount type=bind,src=/var/lib/zhihui-web-acme,dst=/var/lib/zhihui-web-acme \
  certbot/certbot:v5.8.0 certonly --webroot -w /var/lib/zhihui-web-acme \
  -d zhihui.helms.wiki --email '<管理邮箱>' --agree-tos --non-interactive --dry-run
```

证书成功后把 `deploy/nginx.conf` 的内容放入该新增站点文件，`nginx -t && systemctl reload nginx`。该配置包含 WebSocket 升级、SSE 不缓冲、201 MiB 请求体上限（为 200 MiB 文件保留 multipart 开销）、两小时录音连接超时及 Range/If-Range 透传；下载和供应商临时链接均由服务端校验，绝不能 alias 录音存储目录。日志不记录含令牌的请求路径。[Nginx 代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。TLS 申请与续期采用 [Certbot webroot 工作流](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)。

候选阶段使用 18810 回环端口和空的独立临时数据库，核对归档、image ID、版本及源码标签，验证首页、健康路径和匿名会议访问拒绝；不挂载生产数据。

```bash
cd /opt/zhihui-web
./deploy.sh stage 0.6.6-web.5
./deploy.sh activate 0.6.6-web.5
./deploy.sh status
curl --fail https://zhihui.helms.wiki/api/v1/health
curl --fail http://127.0.0.1:8801/api/v1/health
```

也可在本机对已上传的目录先执行 `release-activate.ps1 -ReleaseDirectory web/artifacts/0.6.6-web.5 -Server <SSH账号>@101.200.125.86 -DryRun`，审查后去掉 `-DryRun`。此入口会先 stage 再 activate；不要在已手动 stage 后重复执行，应直接使用上面的 activate 命令。

首次启动后创建管理员（密码通过标准输入，最少 12 个字符；不出现在命令行参数或历史中）：

```bash
cd /opt/zhihui-web
read -rsp '管理员密码: ' admin_password; printf '\n'
printf '%s\n' "$admin_password" | docker compose exec -T app /usr/local/bin/zhihui-web create-admin --username admin
unset admin_password
```

管理员登录后创建一次性邀请，各账号独立设置 API Key、语音/摘要地址及模型，新用户凭据为空。build 2 仅允许固定官方地址：百炼默认端点或 `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`。用户已批准 Token Plan 语音使用同主机原生 `multimodal-generation` 接口、摘要继续使用 OpenAI 兼容接口。设置地址保持上述兼容地址，摘要模型为 `qwen3.8-flash`，语音模型为 `qwen-audio-3.0-asr-flash`。文件 ASR 方案将私有 FLAC 以 Base64 提交，最多 5 分钟（同时受服务器上限约束）、10,000,000 字节音频，不提供边录边转写或自动说话人分离；录音结束后可提交文件任务，说话人可手工编辑。

OpenAI chat ASR 本机探测返回 400，按用户批准改用同主机原生接口。build 2 已通过本机真实上传、私有 FLAC、原生 ASR、兼容摘要、配置保密及重启后同请求编号返回原任务的验收；当前原生 ASR 固定自动语言识别。22 项 Rust 测试覆盖隔离、限额、收费边界与未知结果不重发。未生成新发布镜像，未验证所有音质、语言或真实云端切换。

用两个独立账号验收会议/音频/模板/Key 隔离、上传、Range 下载、纪要和导出；按各账号 `GET /settings` 返回的 ASR 能力验收转写、断线恢复与说话人分离。真实供应商验证需要该服务的有效 Key 和额度，不能用模拟测试代替。HTTPS 才能正常请求浏览器麦克风权限。上线前后对比许可证健康、原有更新清单及安装包哈希。

## 4. 备份、恢复与回滚

`backup.sh` 调用服务端 SQLite online snapshot，再独立执行所有数据库的 `integrity_check`，记录文件 SHA-256；音频一起保留。成功备份保留至少七天，不清除失败证据。备份不包含主密钥；账号数据库和音频是敏感数据，备份目录必须保持私有并复制到独立加密存储。

```bash
cd /opt/zhihui-web
./backup.sh
install -m 644 zhihui-web-backup.service zhihui-web-backup.timer /etc/systemd/system/
install -m 644 zhihui-web-cert-renew.service zhihui-web-cert-renew.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zhihui-web-backup.timer zhihui-web-cert-renew.timer
systemctl list-timers 'zhihui-web-*'
docker run --rm \
  --mount type=bind,src=/etc/letsencrypt,dst=/etc/letsencrypt \
  --mount type=bind,src=/var/lib/zhihui-web-acme,dst=/var/lib/zhihui-web-acme \
  certbot/certbot:v5.8.0 renew --dry-run --cert-name zhihui.helms.wiki
```

监控两个 systemd 单元失败、备份日期/磁盘余量、TLS 有效期、`/api/v1/health` 和容器内存。`docker compose logs --tail 100 app` 只用于受控诊断，不上传包含用户内容的日志。

后续 activate 在切换前强制生成并验证备份，失败即中止。录音会话不能跨进程重启，安排无实时录音的更新窗口；未完成收费任务按供应商任务 ID 恢复查询。健康或匿名访问检查失败自动恢复旧 Web 镜像。手工 `./deploy.sh rollback` 在备份后切回 previous 镜像，不替换数据库、不改变桌面。首版没有 previous 时停止失败候选，需要排查后重发新构建。

自动回滚只允许数据库结构版本相同的发布；当前固定为 1。将来结构变更必须另行准备兼容迁移和还原演练，不可只提高清单数字绕过检查。日常备份是每个数据库各自一致的快照，跨账号库不提供全局同一时刻事务；完整恢复前停止 Web 写入。

恢复必须在空的隔离目录验证：核对备份 `verified.json` 中每个文件哈希与 `integrity_check`，将 online snapshots 按备份相对路径复制为新的测试数据目录，用相同密钥启动回环测试容器，验证两个用户读取和录音下载。确认成功后，先再备份生产数据，停止 Web，保留旧 data 目录，才允许将验证过的还原目录切为 data 并重启。此手册和脚本均不自动替换正式数据库。即使回滚 Web，也不允许修改 `/opt/zhihui-license` 或任何 `latest.json`。

## 验证记录

build 1 已通过锁文件依赖安装、前端测试/类型检查/生产构建、Rust 14 项测试和实际 Linux 镜像构建；制品保存在 `web/artifacts/0.6.6-web.1/`。基础镜像使用显式 AWS 官方公共镜像，运行时包下载曾遇到 Debian HTTP 502，改用同一官方源的 HTTPS 与 APT 缓存后完成。已用 Linux named volume 验证 UID 10001、只读主密钥权限、健康/静态页/匿名 401、在线备份、重启及隔离恢复；Linux 二进制与 Debian FFmpeg 的模拟供应商闭环通过，转写和摘要均仅提交一次。

运维静态检查包括 PowerShell 语法、`release.ps1 -DryRun`、Git Bash `bash -n`、`docker compose config --quiet` 和临时 Nginx 容器配置检查。build 2 已完成上述本机供应商验证；build 1 历史容器验证不能替代当前 build 5 镜像验证。用户已确认备案审核通过，域名 DNS/HTTPS、证书续期/备份定时器及真实服务器切换仍需本轮实际验收。
