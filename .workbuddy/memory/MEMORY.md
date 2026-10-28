# qqbot-dev2 项目约定

## 部署

- 仓库：`github.com/caspian-vex/qqbot-dev2`（public，main 分支）。
- 镜像：CI 推到 `ghcr.io/caspian-vex/qqbot-dev2:{edge,latest}`，匿名可拉。
  **镜像名必须和仓库名一致**：CI 取 `${GITHUB_REPOSITORY,,}`，install.sh / compose 的默认值要跟着改。
- 一键安装：`curl -fsSL https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/install.sh | bash`
  （私有包走 `GHCR_TOKEN=<read:packages>`）。
- 服务器 `root@217.60.5.250`（口令见 `服务器信息.txt`），安装目录 `/opt/qqbot`。
- 本机无 Docker、无 sshpass：远程操作用 paramiko（`C:\Users\vex\.workbuddy\binaries\python\envs\default`），
  脚本在 `.workbuddy-ai/ssh-exec.py`；Git Bash 需 `MSYS_NO_PATHCONV=1` 否则远端路径被改写。
- 本机访问不了 `raw.githubusercontent.com`（curl 返回 000），要验证 raw 下载就到服务器上 curl。

## 架构红线

- 对外只开 5666。NapCat 的 6099 / 3001 不出 compose 内网。
- NapCat WebUI 通过 `/webui` 反代进面板（`src/panel/napcat-proxy.ts`），凭据服务端注入；
  面板自身路由优先，未注册的 `/api/*` 才转协议端（`Router.has()` 判定，别改成前缀判定）。
- 两个容器都跑 uid 1000，`data/` 必须 `1000:1000`，否则 SQLite 报 `unable to open database file`。
- 环境变量短名（`WEBUI_TOKEN`/`ONEBOT_TOKEN`/`SECRET_KEY`）会在 `loadSecrets` 归一成 `QQBOT_` 前缀。
- 登录态被观察到后自动补 3001 反向 WS（`ensureWsServer`）：前端轮询 + 服务端 20s 心跳两条触发路径。
- 面板会话存在内存里，容器一重启就要重新登录（不是 cookie 坏了）。

## 开发

- 前端不用构建：直接改 `web/dist/app.js`（单文件、原生 JS、CSP 禁内联事件 → 用 `data-act` 委托）。
  `.gitignore` 只忽略 `/dist/`，**不能写 `dist/`**，否则 `web/dist` 会被一起忽略。
- 提交前跑 `tsc --noEmit` + `node --import tsx --test "test/**/*.test.ts"`（当前 139 条）。
- 所有 `.sh` 与 `Dockerfile` 必须是 LF（`.gitattributes` 已固定 `eol=lf`，本机 `core.autocrlf=false`）。
- 带凭据的调试脚本一律放 `.workbuddy-ai/`（已 ignore），永不进仓库。
