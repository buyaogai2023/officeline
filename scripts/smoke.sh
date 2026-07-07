#!/bin/bash
# Officeline 冒烟测试:后端 API + DS 集成全链路(需 server 与 officeline-ds 已启动)
set -e
BASE=${BASE:-http://localhost:9130}
EMAIL="smoke-$RANDOM@test.local"; PASS="smoke123"
pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; exit 1; }

T=$(curl -sf -X POST $BASE/api/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
[ -n "$T" ] && pass "注册" || fail "注册"
A="authorization: Bearer $T"

ID=$(curl -sf -X POST $BASE/api/files/new -H "$A" -H 'content-type: application/json' \
  -d '{"name":"冒烟","type":"docx"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
[ -n "$ID" ] && pass "新建文档 $ID" || fail "新建文档"

curl -sf "$BASE/api/files/$ID/raw" -H "$A" -o /tmp/smoke.docx
cmp -s /tmp/smoke.docx "$(dirname "$0")/../server/templates/blank.docx" && pass "下载字节一致" || fail "下载"

DLT=$(curl -sf "$BASE/editor/$ID?token=$T" | sed -n 's/.*callback\/[0-9a-f]*?t=\([A-Za-z0-9_-]*\).*/\1/p' | head -1)
[ -n "$DLT" ] && pass "编辑器页 + 签名" || fail "编辑器页"

# DS 全链路:从我们这拉文件并转 PDF
R=$(curl -sf -X POST http://localhost:8080/ConvertService.ashx -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"async\":false,\"filetype\":\"docx\",\"outputtype\":\"pdf\",\"key\":\"smoke-$RANDOM-$RANDOM\",\"title\":\"s.docx\",\"url\":\"http://host.docker.internal:9130/api/files/$ID/raw?v=1&t=$DLT\"}")
echo "$R" | grep -q '"endConvert":true' && pass "DS 转 PDF(编辑器同款管道)" || fail "DS 转换: $R"

# 模拟保存回调 → 版本+1
curl -sf -X POST "$BASE/onlyoffice/callback/$ID?t=$DLT" -H 'content-type: application/json' \
  -d '{"status":6,"url":"http://localhost/web-apps/apps/api/documents/api.js"}' >/dev/null
V=$(curl -sf "$BASE/api/files/$ID/versions" -H "$A" | sed 's/.*"current":\([0-9]*\).*/\1/')
[ "$V" = "2" ] && pass "回调保存 → v2" || fail "回调保存(current=$V)"

curl -sf -X POST "$BASE/api/files/$ID/restore" -H "$A" -H 'content-type: application/json' -d '{"version":1}' >/dev/null
V=$(curl -sf "$BASE/api/files/$ID/versions" -H "$A" | sed 's/.*"current":\([0-9]*\).*/\1/')
[ "$V" = "3" ] && pass "历史恢复 → v3" || fail "历史恢复"

curl -sf -X POST $BASE/api/ai -H "$A" -H 'content-type: application/json' \
  -d '{"action":"polish","text":"冒烟"}' | grep -q '"aiUsed":1' && pass "AI 计量" || fail "AI 计量"

curl -sf -X DELETE "$BASE/api/files/$ID" -H "$A" >/dev/null && pass "删除"
echo "全部通过 🎉"
