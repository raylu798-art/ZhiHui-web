# Mac mini 部署入口

本仓库是知会 Web **0.6.6 / build 5** 的独立源码。Apple 芯片 Mac mini 请先阅读 [macmini/README.md](macmini/README.md)，在该仓库根目录运行：

```bash
bash macmini/manage.sh start
bash macmini/manage.sh admin
```

首次在 Mac 上构建 Linux/ARM64 镜像；管理员密码和模型 Key 在 Mac 本地设置。此仓库不含生产凭据、会议数据、预构建镜像或桌面安装包。完整产品功能、接口和 Linux 部署说明见 [README.md](README.md)、[API.md](API.md)、[DEPLOY.md](DEPLOY.md)。

`baseline.mjs`、`release.ps1` 是完整桌面/Web 同步发布入口，需要原桌面仓库中的受保护基线文件；本独立仓库只用于 Web 源码管理。Mac 启动使用 `macmini/manage.sh`。
