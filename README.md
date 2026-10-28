# qqbot

一条命令拉起一个能聊天的 QQ 机器人：**NapCat 协议端 + OneBot 接入 + LLM 对话 + 自带 Web 面板**。

不需要改配置文件、不需要装第二套凭据：装完打开 `http://<服务器IP>:5666`，扫码登录 QQ、填一个模型 API Key，就能在 QQ 里对话。

```bash
curl -fsSL https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/install.sh | bash
```

> 面向 Debian / Ubuntu，root 运行。脚本会自己检查 Docker（没装会先问一句），只往 `/opt/qqbot` 写东西。

---

## 特性

- **单端口对外**：只有面板 `5666` 暴露。NapCat 的 6099（WebUI）和 3001（OneBot WS）只在 compose 内网，公网扫不到。
- **扫码即登录**：面板「登录」页内嵌 NapCat 登录流程，扫码/快捷登录都由服务端代理，WebUI token 不下发浏览器。
- **登录后自动接线**：检测到 QQ 登录成功，自动在协议端补一条启用的 3001 反向 WS，不需要手工点按钮。
- **完整协议端控制台**：面板「协议端」页反代 NapCat 原生 WebUI，高级网络配置、插件、日志、进程都在里面。
- **原生手写前端**：`web/dist/app.js` 单文件、无构建步骤，改一行刷新就生效。
- **外观三态**：浅色 / 暗色 / 跟随系统，侧栏底部与登录页可切换，记在浏览器本地，默认暗色。
- **零编译部署**：CI 在 GitHub Actions 上构建 `linux/amd64` + `linux/arm64` 镜像推到 GHCR，服务器只 pull。
- **自带运维命令**：`qqbot status / logs / upgrade / rollback / backup / restore / reset-password`。
- **为 1 核 2G 设计**：两容器内存上限 1.4G，日志服务级轮转，不碰全局 `daemon.json`。

---

## 架构

```
浏览器 ──:5666──▶  qqbot-core  ──ws://napcat:3001──▶  qqbot-napcat ──▶  QQ
                     │  (OneBot v11 正向 WS)
                     └──/webui 反代──http://napcat:6099──▶ NapCat WebUI
```

| 容器 | 镜像 | 对外 | 职责 |
| --- | --- | --- | --- |
| `qqbot-core` | 本仓库构建 | `5666` | 面板、扫码登录代理、OneBot 客户端、LLM 对话、SQLite |
| `qqbot-napcat` | `mlikiowa/napcat-docker` | 无 | QQNT 登录态、消息收发、`3001` WS 服务、`6099` WebUI |

- 两个容器都以 **uid 1000** 运行，`/opt/qqbot/data` 必须归 `1000:1000`（`install.sh` 已处理）。
- 数据落地：`data/qqbot`（SQLite：设置/人格/会话/用量）、`data/napcat`（QQ 登录态）。

---

## 快速开始

### 1. 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Debian / Ubuntu（其他发行版能跑，但未验证） |
| 架构 | `x86_64` / `aarch64`（镜像双架构） |
| 内存 | 建议 ≥ 2GB。1GB 机器 NapCat 容易 OOM，建议先加 2GB swap |
| 权限 | root |
| 网络 | 能访问 `ghcr.io` 与 `raw.githubusercontent.com`；面板端口需在安全组放行 |

### 2. 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/install.sh | bash
```

想换目录或端口（管道模式下环境变量要写在 `bash` 前面）：

```bash
curl -fsSL https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/install.sh \
  | QQBOT_DIR=/opt/qqbot PANEL_PORT=5666 bash
```

脚本做的事，按顺序：检查系统与架构 → 装 Docker（可选）→ 建目录并 `chown 1000` → 生成密钥（**已存在则不覆盖**）→ 写 `etc/qqbot.toml` → 装 `compose.yaml` 与 `qqbot` 命令 → 拉镜像 → 起容器 → 等 `/healthz` → 打印面板地址与初始密码。

在仓库目录里想用本地源码构建（不走 GHCR）：

```bash
bash install.sh --build
```

`--build` 会在本机 `docker build`，1 核机器上要几分钟；默认打 `:dev` 标签，和线上版本区分开。

### 3. 装完三步

1. 浏览器打开 `http://<服务器IP>:5666`，用安装结束打印的初始密码登录（用户 `admin`）。
   密码只打印一次；错过了就 `qqbot reset-password`。
2. 左侧 **「登录」** → 扫码（或点快捷登录）把 QQ 登进协议端。登录成功后会自动补 3001 反向 WS，页面上的「机器人已在线」即为接通。
3. 左侧 **「设置」** → 填模型 `Base URL` 与 `API Key`（默认 DeepSeek，任何 OpenAI 兼容端点都行）→ 保存，立即生效。

私聊机器人发一句话，有回复就通了。

> 如果第 3 步之后仍不回复：看面板「总览」的连接状态，以及 `qqbot logs` 里的 `未连接` / `触发` / `LLM` 关键字。见下方[排障](#排障)。

### 4. 放行端口

装完只差云厂商这一层：

- 安全组 / 防火墙放行 `5666/tcp`。
- 不想对公网开放：在 `/opt/qqbot/etc/env` 里加 `PANEL_BIND=127.0.0.1` 再 `qqbot restart`，然后本地建隧道：

```bash
qqbot tunnel            # 打印现成的 ssh -L 命令与 WebUI token
```

---

## 可选参数

安装脚本认这些环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQBOT_DIR` | `/opt/qqbot` | 安装目录（配置、密钥、数据都在这下面） |
| `PANEL_PORT` | `5666` | 面板端口，同时决定容器监听与宿主映射 |
| `QQBOT_IMAGE` | `ghcr.io/caspian-vex/qqbot-dev2:<版本>` | 换自建仓库时覆盖 |
| `QQBOT_VERSION` | `latest`（`--build` 时为 `dev`） | 镜像 tag |
| `NAPCAT_TAG` | `latest` | NapCat 镜像 tag |
| `TZ` | `Asia/Shanghai` | 容器时区：机器人报时间、峰时判断、用量按天分组都靠它 |
| `GHCR_TOKEN` | 空 | 包为私有时填，需 `read:packages` |
| `GHCR_USER` | `caspian-vex` | 令牌所属账号 |
| `REPO_RAW` | 本仓库 main 的 raw 地址 | 拉了 `compose.yaml` / `qqbot` 命令的源 |

---

## 不用脚本，手动 compose

`install.sh` 干的事就是「准备 `etc/env` + `qqbot.toml` + 起 compose」。要手工来：

```bash
mkdir -p /opt/qqbot/{etc,data/qqbot,data/napcat/{qq,config,plugins,logs}}
chown -R 1000:1000 /opt/qqbot/data
cd /opt/qqbot
curl -fsSLO https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/deploy/compose.yaml

cat > etc/env <<'EOF'
QQBOT_SECRET_KEY=<32 字节 hex>      # 换了它，已存的 API Key 全部解不开
WEBUI_TOKEN=<16 字节 hex>           # 面板代理扫码用，不下发浏览器
PANEL_PORT=5666
TZ=Asia/Shanghai                     # 机器人报时间/峰时判断/用量分组
QQBOT_IMAGE=ghcr.io/caspian-vex/qqbot-dev2:latest
QQBOT_VERSION=latest
NAPCAT_TAG=latest
EOF
chmod 600 etc/env

# 这个文件必须在 up 之前存在：compose 把单文件挂进容器，
# 缺文件时 docker 会替你建成一个目录，容器内路径就变成了目录 → 启动失败。
cat > etc/qqbot.toml <<'EOF'
data_dir = "/opt/qqbot/data"

[log]
level = "info"
format = "text"

[onebot]
url = "ws://napcat:3001"
access_token = ""

[panel]
listen = "0.0.0.0:5666"

[napcat]
webui = "http://napcat:6099"
EOF

docker compose --env-file etc/env up -d
```

模型、触发规则、人格不在这里 —— 它们在 SQLite 里，由面板改、改完立即生效。

顺手把运维命令也装上（可选）：

```bash
curl -fsSL https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/deploy/qqbotctl \
  -o /usr/local/bin/qqbot && chmod 755 /usr/local/bin/qqbot
qqbot status
```

初始密码在 `docker logs qqbot-core | grep 密码`（只在首次启动生成一次）。

---

## 面板

| 页面 | 用途 |
| --- | --- |
| 总览 | 连接状态、版本、今日用量、最近日志 |
| 登录 | 扫码 / 快捷登录、退出登录、3001 反向 WS 体检与修正 |
| 网络 | OneBot 网络配置（HTTP 服务/客户端、WS 服务/客户端、上报格式） |
| 协议端 | 反代 NapCat 原生 WebUI：高级网络配置、插件、日志、进程 |
| 设置 | 模型接入、触发规则（唤醒词默认空、被动概率、白名单、冷却）、上下文窗口 |
| 人格 | 系统提示词与人设，多套可切换 |
| 会话 | 上下文、清空会话 |
| 用量 | token 消耗统计 |
| 账号 | 改面板用户名与密码、TOTP 两步验证 |
| 外观 | 浅色 / 暗色 / 跟随系统，切换器在侧栏底部和登录页 |

面板自身的 `/api/*` 优先匹配，没注册的才转给协议端 —— `/api/auth/login` 两边同名，这条边界不能改成前缀判断。

---

## 运维命令

`install.sh` 会把 `deploy/qqbotctl` 装成 `/usr/local/bin/qqbot`。

| 命令 | 作用 |
| --- | --- |
| `qqbot status` | 容器状态、健康检查、版本 |
| `qqbot url` | 打印面板地址、扫码入口、OneBot 地址 |
| `qqbot logs` | 跟踪 `qqbot-core` 日志 |
| `qqbot restart` / `up` / `down` | 运维基本操作 |
| `qqbot reset-password` | 重置面板密码（忘记密码时用） |
| `qqbot upgrade [tag]` | 拉新镜像并重启，未就绪自动回滚 |
| `qqbot rollback [tag]` | 回到指定版本 |
| `qqbot backup` | 备份 `data/qqbot` + `etc`（自动只留最近 7 份） |
| `qqbot restore <file>` | 从备份恢复 |
| `qqbot tunnel` | 面板只绑本机时，打印 SSH 隧道命令 |
| `qqbot uninstall` | 卸载（保留数据目录） |

常用排查：

```bash
docker logs qqbot-core --tail 100        # 应用日志
docker logs qqbot-napcat --tail 100      # 协议端日志
docker exec qqbot-napcat sh -c 'ls /app/.config/QQ'   # 登录态是否落盘
```

---

## 目录与配置

```
/opt/qqbot
├── compose.yaml          # 编排（install.sh 从仓库复制）
├── etc/
│   ├── env               # 密钥与部署参数，0600，随 qqbot backup 一起备份
│   └── qqbot.toml        # 引导配置：路径/日志/监听/协议端地址
├── data/
│   ├── qqbot/            # SQLite：settings/persona/session/usage
│   └── napcat/           # QQ 登录态、NapCat 配置与插件
└── backup/               # qqbot backup 的产物
```

三层配置的分工，刻意不混：

| 层 | 位置 | 改什么 | 生效方式 |
| --- | --- | --- | --- |
| 部署期 | `etc/env` | 端口、镜像、密钥 | `qqbot restart` |
| 引导期 | `etc/qqbot.toml` | 数据目录、日志级别/格式、监听地址、协议端 URL | 重启容器 |
| 运行期 | SQLite（面板） | 模型、触发规则、人格、上下文 | 保存即生效 |

运行期不放 TOML 的原因：面板若也写 TOML，会冲掉人工注释，并发写还有竞态。

---

## 模型接入

默认指向 DeepSeek，改 `Base URL` 即可换任意 OpenAI 兼容服务：

| 服务 | Base URL | 备注 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | 默认，便宜；**思考模式默认关闭**（机器人场景不需要） |
| OpenAI | `https://api.openai.com/v1` | |
| 自建 / 中转 | 你的地址 | 需兼容 `/chat/completions` |

`temperature`、`max_tokens`、`timeout_sec` 都在设置页。API Key 用 `QQBOT_SECRET_KEY` 派生的密钥加密后存库，换 `QQBOT_SECRET_KEY` 会导致旧 Key 解不开，只能重新填。

---

## 本地开发

前置：Node ≥ 22.13（`engines` 里写死了，`npm test` 的 glob 也依赖 22+）。

```bash
npm ci
npm run dev          # tsx 直跑 src/main.ts，改完重启
npm run typecheck    # tsc --noEmit
npm test             # node --import tsx --test "test/**/*.test.ts"
npm run build        # esbuild 打包到 dist/（server.js + argon-worker.js）
```

- **前端不构建**：直接改 `web/dist/app.js` 与 `style.css`，刷新页面即可。文件是原生 JS，CSP 禁内联事件，所以事件都用 `data-act` 委托。
- **本地跑不需要 Docker**：没有配置文件也能启动（走默认值，根目录 `/opt/qqbot`）。想让运行数据落在仓库外，用
  `QQBOT_ROOT=./.local npm run dev`，需要联调 OneBot 时在该目录的 `etc/qqbot.toml` 里配 `[onebot].url`。
- **改完必须过**：`npm run typecheck` + `npm test`。CI 只认这两条。

开发过程、踩坑与决策记录见 [DEVLOG.md](DEVLOG.md)。

---

## 排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 机器人报的时间不对（差 8 小时或半天） | 容器时区不是东八区（境外服务器默认 UTC） | 在 `etc/env` 里设 `TZ=Asia/Shanghai` 后 `qqbot restart`；2026-10-28 之后的镜像已内置 tzdata，老镜像只设 TZ 不生效需先升级 |
| `qqbot-core` 反复重启，日志 `unable to open database file` | `data/` 属主不是 1000 | `chown -R 1000:1000 /opt/qqbot/data` |
| 面板「登录」「网络」显示未配置 | `etc/env` 里 `WEBUI_TOKEN` 没被读到 | 代码会把短名归一成 `QQBOT_` 前缀；确认 `etc/env` 有 `WEBUI_TOKEN=` 且容器已重启 |
| 扫码成功但机器人显示未连接 | 3001 反向 WS 没启用 | 等 20s（服务端心跳会自动补），仍不行去「登录」页点「修正反向 WS」 |
| `/webui` 401 | 正常：反代要求面板会话 | 先登录面板 |
| 拉镜像 `denied` | 镜像名写错，或包是私有的 | 核对 `ghcr.io/<owner>/qqbot-dev2`；私有包带 `GHCR_TOKEN` |
| 容器重启后浏览器要重新登录 | 会话存在内存里，不在磁盘 | 预期行为，不是 cookie 问题 |
| 改 `/webui` 里的 WS 配置后短暂断连 | 协议端重载网络配置 | 预期，几秒后自愈 |
| NapCat 随机崩、容器 OOM | `/dev/shm` 太小或内存不足 | compose 已给 256MB shm；低于 2GB 内存请加 swap |

---

## 安全说明

- 只对外开 `5666`，且必须经过面板登录；NapCat WebUI 与 OneBot WS 不出容器网络。
- WebUI token 只存在于服务端进程内，浏览器拿到的是占位串。
- 面板密码用 argon2id 哈希（放 worker 里算，1 核机器不阻塞主线程），登录失败按 IP 退避并写审计；支持 TOTP。
- `etc/env` 权限 `0600`，只随 `qqbot backup` 备份；`etc/qqbot.toml` 不含任何密钥。
- `/webui` 的 CSP 单独放宽（NapCat 前端产物需要），面板自身仍用严格 CSP。

---

## 许可

未指定。仅个人使用，自行评估风险。
