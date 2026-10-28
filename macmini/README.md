# Mac mini（Apple 芯片）部署

产品 **0.6.6 / Web build 5**。这是适用于 M 系列芯片的独立源码交付：首次在 Mac 本机生成 Linux/ARM64 镜像，然后由 Docker Desktop 运行，不需要本机安装 Node、Rust 或 FFmpeg。

## 启动

1. 安装并打开 [Docker Desktop for Mac with Apple silicon](https://docs.docker.com/desktop/setup/install/mac-install/)。建议首次构建时为 Docker 留出 4 GiB 或以上内存及 10 GiB 可用磁盘；构建需联网下载依赖，耗时取决于网络与机器。
2. 解压交付包，在终端进入解压目录（可在输入 `cd ` 后把文件夹拖到终端），执行：

```bash
bash web/macmini/manage.sh start
bash web/macmini/manage.sh admin
```

3. 打开 **http://127.0.0.1:8810**，用户名 `admin`，密码为刚刚在终端设置的密码。`admin` 命令用于首次创建，不会重置已有账户；后续启动只运行 `start`。

在“模型与 API”分别填写语音/摘要配置和自己的 Key。Token Plan 地址为 `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`，语音模型 `qwen-audio-3.0-asr-flash` 走同服务原生接口，摘要 `qwen3.8-flash` 走 OpenAI 兼容接口。各新用户单独配置 Key。该语音方案限 5 分钟/10MB 文件，不支持边录边转写和自动说话人分离。

## 日常操作与数据

```bash
bash web/macmini/manage.sh status
bash web/macmini/manage.sh stop
bash web/macmini/manage.sh start
bash web/macmini/manage.sh backup
```

会议、账户、模板与密文配置保存在 `zhihui-macmini_data` 命名卷；主密钥单独位于 `zhihui-macmini_master`，在线备份位于 `zhihui-macmini_backups`。初始化会保留原主密钥，已有数据缺少主密钥时拒绝重新生成。停止、重启及更换解压文件夹不会删除数据。不要删除这些卷，也不要用 Docker Desktop 的清除数据/恢复出厂功能清理它们。

`backup` 使用应用的 SQLite online snapshot，并检查数据库完整性、生成文件大小与 SHA-256 清单，主密钥不包含在数据备份中。命令会打印将该备份复制到 Mac 外部目录的 `docker compose cp` 命令；复制后应独立保存。主密钥另行导出到你选择的私密位置：

```bash
bash web/macmini/manage.sh export-key "$HOME/zhihui-master-key.private"
```

密钥文件只给当前用户读写，不能上传聊天或与会议备份合并；账号密码和 API Key 均不内置在包内。此 Mac 数据与原 Windows/云端数据独立，不做自动同步。需要恢复时先在隔离环境核验备份清单、数据库完整性和原主密钥，再停止写入并保留原卷，禁止直接覆盖正式数据。

## 域名与长期运行

默认只供 Mac 本机访问，端口绑定回环，麦克风使用 localhost 安全上下文。若继续使用 `https://zhihui.helms.wiki`，需先让域名通过公网入口/反向代理抵达 Mac，并配置 HTTPS，然后在同一终端设置 `export ZHIHUI_PUBLIC_URL=https://zhihui.helms.wiki` 后重新运行 `start`。不能继续把域名指向原阿里云 IP 而期待访问到这台 Mac。域名接入方式取决于 Mac 所在网络，本包不会自动修改 DNS、路由器或任何云资源。

在 Docker Desktop 开启登录后启动；容器设为 `unless-stopped`。Mac 休眠、关机、退出 Docker 或账户未登录时服务可能不可用，按实际长期运行需求配置系统设置。此包没有为 macOS 安装 Linux systemd 定时器，在线备份当前为手动命令。

## 源码与验证边界

源码、锁文件、Logo、字体和模板均在 `web/`。本包使用 ARM64 原生构建，旧的阿里云 `image.tar` 是 AMD64，未包含在此包。不要使用 `web/deploy/deploy.sh` 或旧发布清单启动 Mac；Mac 使用这里的 Compose 和脚本。

业务源码保持已验证 build 5 的内容；完整仓库的桌面同步发布仍按 `web/DEPLOY.md` 复核，`baseline.mjs/release.ps1` 需要原完整桌面仓库和安装包。更改业务代码后需生成新 Web 构建和来源指纹，不能沿用本包的指纹和标签。

已通过 Compose 配置、Shell 语法，以及隔离容器中的卷初始化、UID/密钥权限、重复初始化保留密钥、会议/会话重启恢复、在线备份清单/哈希/数据库完整性验证；验收资源已清理。容器流程使用现有 AMD64 验证镜像，当前开发机为 Windows，未在真实 Apple 芯片 Mac 上完成 ARM64 构建及浏览器实机验收；首次在 Mac 执行 `start` 才会构建 ARM64 镜像。Docker 平台与命名卷行为参考 [平台配置](https://docs.docker.com/reference/compose-file/services/#platform)、[持久卷](https://docs.docker.com/reference/compose-file/volumes/)。
