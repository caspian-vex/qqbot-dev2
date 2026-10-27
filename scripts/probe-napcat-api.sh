#!/usr/bin/env bash
# P0 探针：验证 NapCat WebUI API 是否可按设计被 qqbot 服务端驱动。
#
# 目的（对应计划的 P0 阶段）：
#   1. 确认路由前缀是 /api
#   2. 确认登录提交的是 sha256(token + ".napcat") 的 hex
#   3. 确认 GetQQLoginQrcode 返回的 qrcode 字段是 URL 还是 data URL
#   4. 确认 CheckLoginStatus 的实际字段
#   5. 确认 OB11Config/GetConfig 的结构，判断能否自动配置 OneBot WS
#
# 用法：在能访问 NapCat 6099 的机器上执行
#   NAPCAT_TOKEN=xxx NAPCAT_BASE=http://127.0.0.1:6099 ./scripts/probe-napcat-api.sh
set -uo pipefail

TOKEN="${NAPCAT_TOKEN:-}"
BASE="${NAPCAT_BASE:-http://127.0.0.1:6099}"

if [ -z "$TOKEN" ]; then
  echo "缺少 NAPCAT_TOKEN" >&2
  exit 1
fi

say() { printf '\n=== %s ===\n' "$1"; }
body() { sed -e 's/^[[:space:]]*//' | head -c 600; echo; }

HASH=$(printf '%s' "${TOKEN}.napcat" | sha256sum | cut -d' ' -f1)

say "1. 未鉴权访问（应为 code!=0 / Unauthorized）"
curl -s -o /tmp/probe_unauth.txt -w "http=%{http_code}\n" -X POST "$BASE/api/QQLogin/CheckLoginStatus"
body < /tmp/probe_unauth.txt

say "2. 登录 POST /api/auth/login  hash=sha256(token+'.napcat')"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"hash\":\"${HASH}\"}")
echo "$LOGIN" | body

CRED=$(printf '%s' "$LOGIN" | grep -o '"Credential":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$CRED" ]; then
  echo "!! 登录失败，后续接口无法探测"
  exit 2
fi
echo "Credential 长度: ${#CRED}"

AUTH="Authorization: Bearer ${CRED}"

say "3. POST /api/QQLogin/CheckLoginStatus"
curl -s -X POST "$BASE/api/QQLogin/CheckLoginStatus" -H "$AUTH" | body

say "4. POST /api/QQLogin/GetQQLoginQrcode"
QR=$(curl -s -X POST "$BASE/api/QQLogin/GetQQLoginQrcode" -H "$AUTH")
echo "$QR" | body
QRVAL=$(printf '%s' "$QR" | grep -o '"qrcode":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "qrcode 字段长度: ${#QRVAL}"
echo "qrcode 前 40 字符: ${QRVAL:0:40}"

say "5. POST /api/QQLogin/GetQQLoginInfo"
curl -s -X POST "$BASE/api/QQLogin/GetQQLoginInfo" -H "$AUTH" | body

say "6. ALL /api/QQLogin/GetQuickLoginList"
curl -s "$BASE/api/QQLogin/GetQuickLoginList" -H "$AUTH" | body

say "7. POST /api/OB11Config/GetConfig"
curl -s -X POST "$BASE/api/OB11Config/GetConfig" -H "$AUTH" | body

say "8. GET /webui/ （前端是否挂在 /webui 子路径）"
curl -s -o /tmp/probe_webui.html -w "http=%{http_code} size=%{size_download}\n" "$BASE/webui/"
grep -o 'src="[^"]*"' /tmp/probe_webui.html | head -5
grep -o 'href="[^"]*"' /tmp/probe_webui.html | head -5

say "9. GET / （根路径是否也返回前端）"
curl -s -o /tmp/probe_root.html -w "http=%{http_code} size=%{size_download}\n" "$BASE/"
grep -o 'src="[^"]*"' /tmp/probe_root.html | head -3

say "探测结束"
