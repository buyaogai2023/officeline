#!/bin/bash
# Officeline 一键云部署 — 在全新 Ubuntu 服务器(2GB+ 内存,x86/ARM64)上执行:
#   curl -fsSL https://raw.githubusercontent.com/buyaogai2023/officeline/main/deploy/bootstrap-cloud.sh | bash
# 或从本机: ssh <server> 'bash -s' < deploy/bootstrap-cloud.sh
# 幂等:重复执行 = 拉最新代码并重启服务(.env 与数据保留)
set -euo pipefail

REPO=${OFFICELINE_REPO:-https://github.com/buyaogai2023/officeline.git}
DIR=$HOME/officeline
COMPOSE="docker compose -f docker-compose.cloud.yml"

echo '==> 1/6 安装 Docker'
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
# 本脚本内统一用 sudo docker,免除重新登录激活 docker 组的麻烦
sudo docker version >/dev/null

echo '==> 2/6 拉取代码'
sudo apt-get install -y -qq git >/dev/null 2>&1 || true
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR/deploy"

echo '==> 3/6 生成配置(.env 只生成一次)'
PUBIP=$(curl -fsS ifconfig.me || curl -fsS api.ipify.org)
# 域名部署:OFFICELINE_DOMAIN=yourdomain.com bash bootstrap-cloud.sh
# (需先在域名商加 A 记录:app.yourdomain.com 和 ds.yourdomain.com → 本机公网 IP)
DOMAIN=${OFFICELINE_DOMAIN:-}
if [ ! -f .env ]; then
  if [ -n "$DOMAIN" ]; then
    DS_PUBLIC="https://ds.$DOMAIN"
  else
    DS_PUBLIC="http://$PUBIP:8080"
  fi
  cat > .env <<ENV
DS_JWT_SECRET=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
DS_PUBLIC=$DS_PUBLIC
AI_KEY=
ENV
  if [ -n "$DOMAIN" ]; then
    cat >> .env <<ENV
APP_DOMAIN=app.$DOMAIN
DS_DOMAIN=ds.$DOMAIN
COMPOSE_PROFILES=https
ENV
  fi
  chmod 600 .env
  echo "    已生成 deploy/.env(AI 为演示模式;填 AI_KEY 后执行: sudo $COMPOSE restart app)"
elif [ -n "$DOMAIN" ] && ! grep -q '^APP_DOMAIN=' .env; then
  # 已有 IP 模式 .env,追加域名配置并切换 DS_PUBLIC
  sed -i "s|^DS_PUBLIC=.*|DS_PUBLIC=https://ds.$DOMAIN|" .env
  cat >> .env <<ENV
APP_DOMAIN=app.$DOMAIN
DS_DOMAIN=ds.$DOMAIN
COMPOSE_PROFILES=https
ENV
  echo "    已切换为域名模式:app.$DOMAIN / ds.$DOMAIN"
fi

echo '==> 4/6 启动服务(首次拉 Document Server 镜像约 2GB,耐心等)'
sudo $COMPOSE up -d

echo '==> 5/6 等待 DS 就绪并打私网回访补丁(缺它保存文档报错 -4)'
until curl -sf http://localhost:8080/healthcheck >/dev/null 2>&1; do sleep 5; done
# 用 python3:新版 DS 镜像不再自带 node 可执行文件
sudo $COMPOSE exec -T ds python3 -c '
import json
p = "/etc/onlyoffice/documentserver/local.json"
j = json.load(open(p))
j["services"]["CoAuthoring"]["request-filtering-agent"] = {"allowPrivateIPAddress": True, "allowMetaIPAddress": True}
json.dump(j, open(p, "w"), indent=2)
'
sudo $COMPOSE exec -T ds supervisorctl restart ds:converter ds:docservice
until curl -sf http://localhost:8080/healthcheck >/dev/null 2>&1; do sleep 3; done
# 替换编辑器内引擎品牌为 Officeline(社区版忽略 customization.logo)
bash patch-ds-brand.sh deploy-ds-1 || echo '(品牌补丁失败,不影响功能)'

echo '==> 6/6 放行本机防火墙(甲骨文 Ubuntu 镜像自带 iptables 规则,默认只放 22)'
for port in 9130 8080 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || \
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done
sudo netfilter-persistent save 2>/dev/null || true

echo
if grep -q '^APP_DOMAIN=' .env; then
  APP_D=$(grep '^APP_DOMAIN=' .env | cut -d= -f2)
  echo "✅ 部署完成:  https://$APP_D  (证书自动签发,首次访问约等 30 秒)"
  echo "   还差一步:OCI 控制台 → 实例子网 → 安全列表,放行入站 TCP 80 和 443(源 0.0.0.0/0)"
  echo "   确认 DNS:app 和 ds 两条 A 记录都指向 $PUBIP"
else
  echo "✅ 部署完成:  http://$PUBIP:9130"
  echo "   还差一步:OCI 控制台 → 实例子网 → 安全列表,放行入站 TCP 9130 和 8080(源 0.0.0.0/0)"
fi
echo "   验证:注册账号 → 新建文档 → 输入几个字等 3 秒 → 刷新看版本历史"
