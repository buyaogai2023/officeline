#!/bin/bash
# 启动/重建 ONLYOFFICE Document Server 并打上必需补丁:
# 1. JWT_ENABLED=false(本地开发免签名)
# 2. request-filtering-agent 允许私网地址(否则 DS 无法回访宿主机 9130 拉取文档,报错 -4)
set -e
cd "$(dirname "$0")"

docker rm -f officeline-ds 2>/dev/null || true
docker run -d --name officeline-ds --restart unless-stopped -p 8080:80 \
  -e JWT_ENABLED=false \
  --add-host=host.docker.internal:host-gateway \
  onlyoffice/documentserver:latest

echo "等待 Document Server 就绪…"
until curl -sf http://localhost:8080/healthcheck >/dev/null 2>&1; do sleep 3; done

# 启动脚本会重新生成 local.json,就绪后再注入私网访问许可
# (用 python3:新版 DS 镜像不再自带 node 可执行文件)
docker exec officeline-ds python3 -c '
import json
p = "/etc/onlyoffice/documentserver/local.json"
j = json.load(open(p))
j["services"]["CoAuthoring"]["request-filtering-agent"] = {"allowPrivateIPAddress": True, "allowMetaIPAddress": True}
json.dump(j, open(p, "w"), indent=2)
'
docker exec officeline-ds supervisorctl restart ds:converter ds:docservice
until curl -sf http://localhost:8080/healthcheck >/dev/null 2>&1; do sleep 3; done
echo "Document Server 就绪:http://localhost:8080"
