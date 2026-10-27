#!/usr/bin/env bash
#
# qqbot 一键安装脚本。
#
# 目标：在一台干净的 Debian/Ubuntu 上，一条命令把机器人跑起来：
#   curl -fsSL https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main/install.sh | bash
# 装完打印一个 URL，打开它扫码 + 填 API Key 就能在 QQ 里对话。
#
# 三条原则：
#   1. 幂等。重复执行只补缺的，不覆盖已有密钥（覆盖了 API Key 就解不开了）
#   2. 不静默改动系统。装 docker 会问，改防火墙会问，只写 /opt/qqbot 下的东西
#   3. 失败要说人话。每一步的报错都要告诉用户「现在该做什么」
#
# 两种镜像来源：
#   默认      从 GHCR 拉现成镜像（生产部署，零编译）
#   --build   用当前目录的源码本地构建（开发自测、没有镜像仓库时）
set -euo pipefail

BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    -h|--help)
      cat <<'USAGE'
用法: install.sh [--build]

  (无参数)  从 GHCR 拉现成镜像安装，零编译，适合生产部署
  --build   用当前目录的源码本地构建镜像后安装，适合开发自测
  -h        显示这段帮助

环境变量:
  QQBOT_DIR    安装目录，默认 /opt/qqbot
  PANEL_PORT   面板端口，默认 5666
  QQBOT_IMAGE  镜像名，默认 ghcr.io/caspian-vex/qqbot:<版本>
USAGE
      exit 0
      ;;
    *) printf '未知参数: %s（可用: --build）\n' "$arg" >&2; exit 2 ;;
  esac
done

QQBOT_DIR="${QQBOT_DIR:-/opt/qqbot}"
PANEL_PORT="${PANEL_PORT:-5666}"
NAPCAT_TAG="${NAPCAT_TAG:-latest}"
# 本地构建默认打 dev 标签，避免和 GHCR 上的正式版本混淆
if [ "$BUILD" = "1" ] && [ -z "${QQBOT_VERSION:-}" ]; then
  QQBOT_VERSION="dev"
fi
QQBOT_VERSION="${QQBOT_VERSION:-latest}"
# 镜像名。自建仓库时用 QQBOT_IMAGE=registry/xxx/qqbot:tag 覆盖
QQBOT_IMAGE="${QQBOT_IMAGE:-ghcr.io/caspian-vex/qqbot:${QQBOT_VERSION}}"
# 仓库原始地址，用于拉 compose.yaml 与 qqbotctl
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/caspian-vex/qqbot-dev2/main}"
# 脚本自身所在目录：--build 时它就是构建上下文
SRC_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"

# ---------- 输出 ----------

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_END=''
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_END" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_END" "$*"; }
die()  { printf '%s错误:%s %s\n' "$C_ERR" "$C_END" "$*" >&2; exit 1; }
step() { printf '\n%s==>%s %s\n' "$C_DIM" "$C_END" "$*"; }

# ---------- 前置检查 ----------

step "检查环境"

[ "$(id -u)" = "0" ] || die "请用 root 运行（安装需要写 /opt 和操作 docker）"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "系统 ${PRETTY_NAME:-unknown}"
else
  warn "无法识别系统版本，继续尝试"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64|arm64) ok "架构 $ARCH" ;;
  *) die "不支持的架构 $ARCH（镜像只有 amd64 与 arm64）" ;;
esac

MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 1800 ]; then
  warn "内存 ${MEM_MB}MB，低于建议的 2GB。NapCat 跑 QQNT 会比较吃紧。"
fi

# 无 swap 的机器在 NapCat 启动瞬间容易 OOM。只提示，不自动改——
# 加 swap 是系统级决策，不该由安装脚本偷偷做。
if [ "$(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 1)" = "0" ]; then
  warn "未启用 swap。若 NapCat 反复重启，建议加 2GB swap："
  warn "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi

# ---------- Docker ----------

step "检查 Docker"

if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else
  warn "未安装 Docker"
  say  "  即将执行官方安装脚本 get.docker.com（会安装 docker-ce 与 compose 插件）"
  if [ -t 0 ]; then
    printf '  继续？[y/N] '
    read -r ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) die "已取消。手动装好 docker 后重新运行本脚本即可。" ;;
    esac
  fi
  curl -fsSL https://get.docker.com | sh || die "Docker 安装失败，请检查网络或换用国内镜像源"
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "docker 已安装"
fi

docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件。Debian: apt install docker-compose-plugin"
ok "compose $(docker compose version --short 2>/dev/null || echo ok)"

# ---------- 目录 ----------

step "准备目录 $QQBOT_DIR"

mkdir -p "$QQBOT_DIR"/{etc,data/qqbot,data/napcat/{qq,config,plugins,logs}}

# 两个容器的进程都是 uid 1000（NapCat 的 NAPCAT_UID，node:alpine 里的 node 用户），
# 数据目录必须归 1000，否则症状是：NapCat 起来就退出、qqbot 反复重启并报
# "unable to open database file"。整个 data 一起 chown，省得下次加目录又漏。
chown -R 1000:1000 "$QQBOT_DIR/data" 2>/dev/null || true
ok "目录就绪"

# ---------- 密钥 ----------
#
# 幂等的关键：已存在的密钥绝不覆盖。
# QQBOT_SECRET_KEY 一换，库里加密的 API Key 就再也解不开，只能重新录入。

step "生成密钥"

ENV_FILE="$QQBOT_DIR/etc/env"
[ -f "$ENV_FILE" ] || { umask 077; : > "$ENV_FILE"; }
chmod 600 "$ENV_FILE"

env_has() { grep -q "^$1=" "$ENV_FILE" 2>/dev/null; }
env_set() {
  if env_has "$1"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
env_get() { grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }

gen_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

if env_has QQBOT_SECRET_KEY; then
  ok "QQBOT_SECRET_KEY 已存在，保留（换掉会导致已存的 API Key 无法解密）"
else
  env_set QQBOT_SECRET_KEY "$(gen_hex 32)"
  ok "QQBOT_SECRET_KEY 已生成"
fi

if env_has WEBUI_TOKEN; then
  ok "WEBUI_TOKEN 已存在，保留"
else
  env_set WEBUI_TOKEN "$(gen_hex 16)"
  ok "WEBUI_TOKEN 已生成（面板扫码登录用，不会下发给浏览器）"
fi

env_set PANEL_PORT "$PANEL_PORT"
env_set QQBOT_IMAGE "$QQBOT_IMAGE"
env_set QQBOT_VERSION "$QQBOT_VERSION"
[ -n "$(env_get NAPCAT_TAG)" ] || env_set NAPCAT_TAG "$NAPCAT_TAG"
ok "端口 $PANEL_PORT"

# ---------- 引导配置 ----------

step "写入配置"

CONFIG_FILE="$QQBOT_DIR/etc/qqbot.toml"
if [ -f "$CONFIG_FILE" ]; then
  ok "qqbot.toml 已存在，保留"
else
  cat > "$CONFIG_FILE" <<'TOML'
# qqbot 引导配置（容器内路径）
#
# 只放「部署期确定」的项：路径、监听地址、协议端地址。
# 模型、人格、触发规则这些高频调整的项在 SQLite 里，由面板改，改完立即生效。
# 分开的原因：面板若也写 TOML，人工加的注释会被冲掉，且并发写有竞态。

data_dir = "/opt/qqbot/data"

[log]
# debug / info / warn / error
level = "info"
# text 更好读；要接日志采集再换 json
format = "text"

[onebot]
# 容器网络内用服务名寻址
url = "ws://napcat:3001"
# 留空。3001 只在 compose 内网可达，外部拿不到。
access_token = ""

[panel]
# 会被 compose 的 QQBOT_LISTEN 覆盖，改端口请改 etc/env 的 PANEL_PORT
listen = "0.0.0.0:5666"

[napcat]
# 会被 compose 的 QQBOT_NAPCAT_WEBUI 覆盖
webui = "http://napcat:6099"
TOML
  chmod 644 "$CONFIG_FILE"
  ok "qqbot.toml 已写入"
fi

# ---------- compose 与运维命令 ----------

step "安装编排文件"

COMPOSE_FILE="$QQBOT_DIR/compose.yaml"
if [ -f ./deploy/compose.yaml ]; then
  cp ./deploy/compose.yaml "$COMPOSE_FILE"
elif [ -f "$(dirname "$0")/deploy/compose.yaml" ]; then
  cp "$(dirname "$0")/deploy/compose.yaml" "$COMPOSE_FILE"
else
  curl -fsSL "$REPO_RAW/deploy/compose.yaml" -o "$COMPOSE_FILE" \
    || die "下载 compose.yaml 失败。可以手动把仓库里的 deploy/compose.yaml 放到 $COMPOSE_FILE"
fi
ok "compose.yaml 就绪"

if [ -f ./deploy/qqbotctl ]; then
  install -m 755 ./deploy/qqbotctl /usr/local/bin/qqbot
elif [ -f "$(dirname "$0")/deploy/qqbotctl" ]; then
  install -m 755 "$(dirname "$0")/deploy/qqbotctl" /usr/local/bin/qqbot
else
  curl -fsSL "$REPO_RAW/deploy/qqbotctl" -o /usr/local/bin/qqbot && chmod 755 /usr/local/bin/qqbot \
    || warn "安装 qqbot 运维命令失败，可稍后手动下载"
fi
ok "运维命令 qqbot 已安装"

# ---------- 准备镜像 ----------

if [ "$BUILD" = "1" ]; then
  step "本地构建镜像 $QQBOT_IMAGE"
  [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/Dockerfile" ] \
    || die "--build 需要在仓库目录里运行（当前目录找不到 Dockerfile）"

  # 构建参数只影响 /healthz 之外的一行版本信息，取不到就填 unknown，
  # 不让 git 缺失这种小事把整个安装卡住
  COMMIT="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  say "  上下文 $SRC_DIR"
  say "  版本   $QQBOT_VERSION ($COMMIT)"
  # 1 核 2G 的机器上 npm ci + esbuild 大概 1-2 分钟，提示一下免得用户以为卡死
  say "  首次构建需要几分钟（npm ci + 打包），请耐心等待…"
  docker build \
    --build-arg QQBOT_VERSION="$QQBOT_VERSION" \
    --build-arg QQBOT_COMMIT="$COMMIT" \
    --build-arg QQBOT_BUILD_DATE="$BUILT_AT" \
    -t "$QQBOT_IMAGE" \
    "$SRC_DIR" || die "镜像构建失败，往上翻构建日志"
  ok "镜像已构建"
fi

step "启动容器"

cd "$QQBOT_DIR"
if [ "$BUILD" = "1" ]; then
  # 本地镜像不在仓库里，pull 必然失败；up 会用本地已有的镜像
  docker compose --env-file "$ENV_FILE" up -d || die "启动失败，查看日志：docker compose -f $COMPOSE_FILE logs"
else
  docker compose --env-file "$ENV_FILE" pull || die "拉取镜像失败。检查网络，或确认镜像名 $QQBOT_IMAGE 存在"
  docker compose --env-file "$ENV_FILE" up -d || die "启动失败，查看日志：docker compose -f $COMPOSE_FILE logs"
fi

# ---------- 等就绪 ----------

step "等待面板就绪"

READY=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<服务器IP>}"

if [ "$READY" = "1" ]; then
  ok "面板已就绪"
else
  warn "面板 40 秒内未就绪。先看日志："
  warn "  cd $QQBOT_DIR && docker compose logs --tail=50 qqbot"
fi

# 首次启动的初始密码只打印在容器日志里，且只出现一次。
# 这里直接从日志里取出来展示，省得用户自己去翻 docker logs。
INIT_PW="$(docker logs qqbot-core 2>&1 | grep -o '密码  : [a-f0-9]\{32\}' | tail -1 | awk '{print $3}' || true)"

cat <<EOF

$(printf '%s' "$C_OK")================ 安装完成 ================$(printf '%s' "$C_END")

  面板地址: http://${IP}:${PANEL_PORT}
  用户名  : admin
EOF

if [ -n "$INIT_PW" ]; then
  cat <<EOF
  初始密码: ${INIT_PW}
            ${C_DIM}（只显示这一次，登录后请立即修改）${C_END}
EOF
else
  cat <<EOF
  初始密码: 见 docker logs qqbot-core | grep 密码
            ${C_DIM}（首次启动才生成；已存在密码时不会重新生成）${C_END}
EOF
fi

cat <<EOF

接下来三步：
  1. 打开上面的地址，用初始密码登录
  2. 左侧「登录」页扫码，把机器人 QQ 登进协议端
  3. 左侧「设置」页填模型 API Key（DeepSeek 或任意 OpenAI 兼容端点）

常用命令：
  qqbot status      运行状态
  qqbot logs        跟踪日志
  qqbot restart     重启
  qqbot reset-password  重置面板密码（忘记密码时用）
  qqbot update      拉新镜像并重启

安装目录: ${QQBOT_DIR}
  配置   ${QQBOT_DIR}/etc/qqbot.toml
  密钥   ${QQBOT_DIR}/etc/env
  数据   ${QQBOT_DIR}/data

EOF
