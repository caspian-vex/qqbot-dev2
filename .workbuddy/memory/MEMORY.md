# qqbot-dev2 项目约定

## 部署

- 服务器 `root@217.60.5.250`（密码见 `服务器信息.txt`），源码目录 `/root/qqbot-dev2`，安装目录 `/opt/qqbot`。
- 交付方式：本地打包（排除 `node_modules`/`dist`/`.git`，**必须包含 `web/dist`**）上传后，
  在服务器上跑 `bash install.sh --build` 本地构建镜像；不依赖 GHCR/CI。
- 本机无 Docker、无 sshpass：远程操作用 paramiko（`C:\Users\vex\.workbuddy\binaries\python\envs\default`），
  脚本在 `.workbuddy-ai/ssh-exec.py`；Git Bash 需 `MSYS_NO_PATHCONV=1` 否则远端路径被改写。

## 架构红线

- 对外只开 5666。NapCat 的 6099 / 3001 不出 compose 内网。
- NapCat WebUI 通过 `/webui` 反代进面板（`src/panel/napcat-proxy.ts`），凭据服务端注入；
  面板自身路由优先，未注册的 `/api/*` 才转协议端（`Router.has()` 判定，别改成前缀判定）。
- 两个容器都跑 uid 1000，`data/` 必须 `1000:1000`，否则 SQLite 报 `unable to open database file`。
- 环境变量短名（`WEBUI_TOKEN`/`ONEBOT_TOKEN`/`SECRET_KEY`）会在 `loadSecrets` 归一成 `QQBOT_` 前缀。

## 开发

- 前端不用构建：直接改 `web/dist/app.js`（单文件、原生 JS、CSP 禁内联事件 → 用 `data-act` 委托）。
- 提交前跑 `tsc --noEmit` + `node --import tsx --test "test/**/*.test.ts"`（当前 134 条）。
- 所有 `.sh` 与 `Dockerfile` 必须是 LF，否则服务器上 `env: 'bash\r'`。
