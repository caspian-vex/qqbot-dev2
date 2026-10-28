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
- **不内嵌协议端管理界面**：NapCat 原生 WebUI 不通过面板暴露；「协议端」页只保留保活所需的状态与操作（在线状态、扫码入口、退出登录、3001 反向 WS）。
- **图池按标签分类**：面板「图池」页建标签、写备注、拖拽传图；备注写进提示词，模型自己判断"这句话好笑，该发 funny 里的图"。也可以直接往 `data/qqbot/images/<标签>/` 拷图。
- **看得懂图**：用户 @ 或私聊发来的图片会被下载并随消息交给模型（默认模型支持），截图、照片、表情包都能接。单条消息最多 4 张、单张 ≤ 5MB，取不到的图自动降级成纯文字，不会因此不回复。
- **会自己上网查**：开启后把 `web_search` 作为工具交给模型，新闻、比分、价格、天气这类时效问题它会去查，闲聊不会。搜索走 DeepSeek 官方 Search API，与模型共用 API Key，不用再配第三方搜索源；搜索失败或模型不支持工具调用时自动降级成普通对话。
- **按会话分人格**：私聊 1 可以是女儿型、私聊 2 是傲娇、群 1 像群友、群 2 害羞——在「会话」页每行直接选人格，没选过的会话跟随全局默认。还没说过话的群/好友也能先配（「添加对话对象」，从已加入的群和好友里挑）。会话表按**群名/对方昵称**列，号码退到第二行。
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
                     └──/api/qq/*（扫码、状态、网络配置）──http://napcat:6099──▶ NapCat WebUI API
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
| 协议端 | 保活面板：QQ 在线状态、OneBot 连接、3001 反向 WS、退出登录。**不再内嵌 NapCat 原生界面** |
| 设置 | 模型接入、触发规则（唤醒词默认空、被动概率、白名单、冷却）、主动发言（回声式跟进，默认关）、图池开关（默认关）、图片识别、联网搜索（默认关）、上下文窗口 |
| 图池 | 按标签分类的图片库：建标签、写备注（给模型看的说明）、拖拽上传、删图改名 |
| 人格 | 系统提示词与人设，多套可切换（全局默认） |
| 会话 | 上下文、清空会话、给每个群/私聊单独指定人格（含还没说过话的对象）；按群名/昵称列出 |
| 用量 | token 消耗统计 |
| 账号 | 改面板用户名与密码、TOTP 两步验证 |
| 外观 | 浅色 / 暗色 / 跟随系统，切换器在侧栏底部和登录页 |

面板不转发任何请求给 NapCat 的 WebUI：扫码与网络配置都走面板自己的 `/api/qq/*`，由服务端持 token 调 NapCat API。

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
│   ├── qqbot/            # SQLite：settings/persona/session/usage + images/（图池，一标签一目录）
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

## 图池（按标签分类的配图）

面板「图池」页管标签与图片，一个标签就是一个子目录，**目录即标签**：

```
data/qqbot/images/
├── funny/            ← 标签 funny
│   ├── 1.jpg
│   └── 2.png
├── 可爱/
└── 随手放的.png       ← 根目录的散图，算「未分类」
```

1. 建标签，写备注。备注是**给模型看的说明**，写清"这一类图是什么、什么场景适合发"。
   例：`funny` → `好笑的梗图与沙雕表情包，群里出现好笑的事、被调侃时发`。
2. 传图：拖进标签卡，或点「上传图片」。jpg / png / gif / webp / bmp，单张 ≤ 8MB，类型按文件头判断。
3. 设置页打开「允许机器人发图」，可选单条回复最多几张（1-3）。

开启后，每次回复前会把「标签 + 备注 + 示例文件名」注入系统提示。模型想发图时在回复末尾单独一行写：

- `[图:funny]` —— 从 funny 里**随机**挑一张（模型只需判断"该发哪一类"）
- `[图:funny/1.jpg]` —— 指定某一张

解析端只认池子里真实存在的文件：标签不存在、文件不存在、写了 `../` 一律丢弃，
标记本身也会从正文里剥干净，绝不会当聊天内容发出去。发过图会在会话历史里补一句
`（发了一张图：funny/1.jpg）`，下一轮模型知道自己发过什么。

> 也可以直接把图拷进 `data/qqbot/images/<标签>/`，无需重启、无需再点任何按钮——
> 文件系统就是唯一事实来源，库里只存标签备注。

---

## 按会话分人格

同一个机器人，对不同的人可以说不同的话：私聊 1 当女儿、私聊 2 傲娇、
群 1 像群友、群 2 害羞——每套人设就是「人格」页里的一条人格（系统提示词）。

用法两步：

1. 面板「人格」页建好几套提示词（比如 `女儿`、`傲娇`、`群友型`、`害羞`）；
2. 到「会话」页，在每一行右侧的「人格」下拉里，给这个群 / 私聊选一个。

**还没说过话的群 / 好友**（刚拉进群、刚加好友，一条消息都没来过）也能先配：
点「会话」页右上角「**添加对话对象**」，从已加入的群和已加的好友里选一个、
挑人格、点「指定」。列表里只会列出还没有会话的对象，可以按群名/昵称/号码搜。
保存后它会出现在会话表最上面，标着「尚未对话」，等它说第一句自动生效。
面板展开后，卡片标题右侧的「**取消**」可以直接收起来（和右上角那个按钮等价）。

会话表第一列是**对话对象的名字**——群聊显示群名，私聊显示对方昵称（好友则用你设的备注），
下面一行小灰字是对应的 `group:群号` / `private:QQ号`：同名群、改过备注的好友都可能撞上，
出问题时得能一眼抄出号码去查。名字在收到消息时随会话一起记下（群名复用算人设变量
时已经拉过的那一次），老会话没有记录就临时问协议端要一次群/好友列表；协议端掉线时
两样都拿不到，才退回只显示号码。

协议端没连上、拉不到群列表时，同一个面板底部可以**手动填会话 ID**
（`group:群号` 或 `private:QQ号`）——临时会话、非好友私聊只能这么加。

规则：

- 下拉里的**跟随默认**表示用「人格」页标着「使用中」的那套；改全局默认只影响没单独指定过的会话。
- 绑定是**固定**的：之后把全局默认换成别的，已经指定过的会话仍用自己那套。
- 保存即生效，下一条消息就是新人设，不用重启；**历史消息不会被清掉**，换了人设仍看得到之前的上下文（想切断就顺手点「清空」）。
- 绑定按「对话对象」算，不看窗口：群号与 QQ 号分开，同号也不会串。
- 预设过的对象会记住群名/昵称，说过话之后那一行仍显示名字，不会退回一串号码。
- 群改名、好友改备注后，下一次收到消息就会更新（记名字不额外发请求：群名用的是算 `{{group_name}}` 时那一次的结果）。
- 回声式跟进（主动发言）同样按会话取人格，不会出现"刚用傲娇说完，跟进一句正经的"。

---

## 图片识别（用户发来的图）

用户发图时，机器人把图下载下来，按 OpenAI 兼容的 `image_url` 内容块随消息一起发给模型，
默认模型（`deepseek-flash`）本身就能看图。设置页「图片识别」卡片控制开关与单条上限。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 识别用户发来的图片 | 开 | 关掉后图片段被忽略，只处理文字；用纯文字模型时请关掉 |
| 单条消息最多看几张 | 4 | 超出的图**不下载**，直接丢 |
| 单张大小上限 | 5MB | 与图池一致；超限的图按取不到处理 |
| 单条消息图片总量 | 8MB | 超出的图**不进请求**，避免 base64 把请求体撑到网关 413 |
| 下载超时 | 8 秒 | 单张超时不影响其它张，也不影响文字回复 |

几个刻意的取舍：

- **取图失败不影响回复**。一张图下载失败、超出上限、或者根本不是图片（改名的 html），
  都只是"这张看不到"；带文字的消息照常按文字回答。只有"只发了图且一张都没取到"才会回一句
  「这张图我没加载出来，再发一次？」——而不是「在的，怎么了？」（后者会让人以为机器人根本没收到图）。
- **类型只信文件头**。协议端给的 `Content-Type` 经常是 `application/octet-stream`，
  照抄会让模型收到一个解不开的 data URL，所以和面板传图一样用文件头嗅探。
- **历史里不存图**。会话库只记 `（附图 2 张）`，不存 base64——否则库几天就涨到 GB。
  代价是旧图不会重发：模型知道"上一轮有过图"，但只有当前这一轮的图是看得见的。
- **群里的纯图片不会触发被动接话**：旁听模式只对文字生效，表情包刷屏不会让机器人凑上来；
  @、唤醒词与私聊则照常带图。

> 用的是中转或非多模态模型时，带图请求可能直接报错，机器人会回一句兜底话术。
> 这时把「识别用户发来的图片」关掉即可，文字聊天不受影响。

---

## 联网搜索

开启后，机器人会把 `web_search` 作为一个工具交给模型（OpenAI 兼容的 function calling），
由**模型自己判断**这句话要不要查：「昨晚那场球谁赢了」「现在金价多少」会去查，
「今天好累」不会。查到的结果作为工具结果回填给模型，再由它用正常聊天的口吻答出来。

设置页「联网搜索」卡片：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 允许模型联网搜索 | 关 | 需要模型支持工具调用；不支持时自动退回普通对话 |
| 每次取几条结果 | 5 | 1-10；摘要会占上下文预算 |
| 每条消息最多搜几次 | 2 | 1-3；**成本硬闸**，每多一次就是一次模型请求加一次搜索请求 |

搜索后端只有一家：**DeepSeek 官方 Search API**（`POST /v1/tools/search`），
和模型共用同一把 API Key，所以面板上不需要选源、也不用再填一份凭证。
地址由「模型接口地址」自动派生（`<base>/v1/tools/search`），走中转时落在中转域名下。

几个刻意的取舍：

- **不让程序猜关键词**。猜宽了，聊一句"好累"也去查新闻，回答全是念稿子；猜窄了，
  该查时不查，开始编。交给模型判断，代价只是要支持工具调用。
- **失败一律降级，不拒绝服务**。端点不认 `tools` → 退回不带工具的普通请求；
  搜索源报错/超时 → 把失败原话作为工具结果给模型，它通常会老实说"没查到"；
  次数用尽 → 不再给工具，让它用已有信息收尾。这三种情况用户都能收到正常回复。
- **搜索结果不进历史**。会话库只存用户原话与最终答复，不存摘要——否则每一轮都会被
  重新计费，而且上下文预算会被几周前的旧闻吃掉。
- **次数是硬上限**。模型一次要查两条、而额度只剩一条时，多出来的那条会收到
  「本次搜索次数已用完」的工具回复，不会偷偷多发请求。
- **跟进不搜索**。回声式跟进是主动补一句闲话，跟一句"我刚查了下"很出戏。

> **关于「模型自带联网」**：这里用的是 DeepSeek 的 [网页搜索接口](https://api-docs.deepseek.com/zh-cn/guides/search)
> （`POST /v1/tools/search`），它是独立的搜索服务、与模型无关，`deepseek-flash` 照样能用。
> 容易混淆的是另一套东西：Responses API 里可以声明内置 `web_search` 工具，那个只在
> `deepseek-v4-pro` 上执行，传给 `deepseek-flash` 会被服务端静默忽略——看起来配好了、永远不搜。
> 计费按成功请求算（¥5 / 千次，`results` 为空或请求失败不计费，`count` 不影响单价）。

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
| 拉镜像 `denied` | 镜像名写错，或包是私有的 | 核对 `ghcr.io/<owner>/qqbot-dev2`；私有包带 `GHCR_TOKEN` |
| 容器重启后浏览器要重新登录 | 会话存在内存里，不在磁盘 | 预期行为，不是 cookie 问题 |
| 改「网络」页保存后短暂断连 | 协议端重载 OneBot 服务 | 预期，几秒后自愈 |
| 发了图机器人说「这张图我没加载出来」 | 图超过 5MB、协议端没给出可下载地址，或下载超时 | 重发一次；反复失败时看日志关键字 `图片一张都没取到` |
| 带图消息回「我这会儿有点卡住了」 | 当前模型不支持图片输入（中转常见） | 换多模态模型，或在设置页关掉「识别用户发来的图片」 |
| 开了联网搜索但从没见它查过 | 模型不支持工具调用（function calling），引擎已静默退回普通对话 | 日志搜 `不支持工具调用`；换支持 function calling 的模型 |
| 搜索一直失败，日志 `HTTP 401` | 搜索 Key 错、过期，或与搜索源不匹配（例如填了博查的 Key 却选 Tavily） | 在设置页重填 Key；换源时 Key 要一起换 |
| 自建 SearXNG 报「返回的不是 JSON」 | 实例没开 json 格式 | 在 `settings.yml` 的 `search.formats` 里加上 `json` 后重启实例 |
| NapCat 随机崩、容器 OOM | `/dev/shm` 太小或内存不足 | compose 已给 256MB shm；低于 2GB 内存请加 swap |

---

## 安全说明

- 只对外开 `5666`，且必须经过面板登录；NapCat WebUI 与 OneBot WS 不出容器网络。
- WebUI token 只存在于服务端进程内，浏览器拿到的是占位串。
- 面板密码用 argon2id 哈希（放 worker 里算，1 核机器不阻塞主线程），登录失败按 IP 退避并写审计；支持 TOTP。
- `etc/env` 权限 `0600`，只随 `qqbot backup` 备份；`etc/qqbot.toml` 不含任何密钥。
- NapCat 原生 WebUI 不经面板暴露（6099 只在 compose 内网），因此 CSP 无需为它放宽，面板全程严格 CSP。

---

## 许可

未指定。仅个人使用，自行评估风险。
