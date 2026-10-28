# qqbot 镜像。
#
# 两段式：构建段装 devDependencies 并打包，运行段只带产物。
# 运行段没有任何 node_modules —— esbuild 已经把 ws/qrcode/smol-toml/hash-wasm
# 全部打进 dist/server.js，所以最终镜像里只有 node 运行时 + 两个 js 文件 + 前端。
#
# 为什么用 alpine 而不是 distroless：
#   healthcheck 需要 wget（busybox 自带），排障时也需要 sh。
#   省下的十几 MB 不值得让运维在容器里连 shell 都没有。

ARG NODE_VERSION=24

# ---------- 构建段 ----------
FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /src

# 先只拷依赖清单：源码改动不会让这一层失效，重复构建能吃到缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json esbuild.mjs ./
COPY src ./src
COPY web ./web

# 版本三元组由 CI 注入，esbuild 会把它编译进产物（见 esbuild.mjs 的 define）
ARG QQBOT_VERSION=dev
ARG QQBOT_COMMIT=none
ARG QQBOT_BUILD_DATE=unknown
ENV QQBOT_VERSION=${QQBOT_VERSION} \
    QQBOT_COMMIT=${QQBOT_COMMIT} \
    QQBOT_BUILD_DATE=${QQBOT_BUILD_DATE}

RUN npm run build

# ---------- 运行段 ----------
FROM node:${NODE_VERSION}-alpine AS runtime

# tini 负责转发信号并回收僵尸进程。
# 没有它，docker stop 的 SIGTERM 到不了 node，容器只能等 10 秒超时被 SIGKILL，
# 面板就来不及优雅关闭 SSE 连接和 SQLite。
#
# tzdata 不能省：机器人报时间、DeepSeek 峰时判断、用量按天分组都依赖本地时区。
# alpine 默认没有 zoneinfo，只设 TZ=Asia/Shanghai 会静默回退成 UTC——
# 症状是「服务器在中国境外时，机器人总说凌晨」。装了 tzdata 后 TZ 才真正生效。
RUN apk add --no-cache tini tzdata

WORKDIR /app

# 只拷产物：dist 是两个 js（server + argon worker），web/dist 是前端
COPY --from=build /src/dist ./dist
COPY --from=build /src/web/dist ./web/dist
COPY --from=build /src/package.json ./package.json

# 安装根目录。数据与密钥都在这里，容器重建不丢。
# 目录必须存在且属主是 node，否则首次启动创建 SQLite 会失败。
ENV QQBOT_ROOT=/opt/qqbot \
    QQBOT_LISTEN=0.0.0.0:5666 \
    NODE_ENV=production \
    # 默认东八区：用户和 QQ 好友在中国。compose 的 etc/env 里设 TZ 可覆盖。
    TZ=Asia/Shanghai
RUN mkdir -p /opt/qqbot/etc /opt/qqbot/data && chown -R node:node /opt/qqbot

USER node

# 容器内必须监听 0.0.0.0，否则端口映射打不进来——
# 这是"容器 healthy 但浏览器连不上"最常见的成因
EXPOSE 5666

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:5666/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/dist/server.js"]
CMD ["run"]
