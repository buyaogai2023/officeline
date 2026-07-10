#!/bin/bash
# 把 Document Server(社区版)编辑器内的引擎品牌 logo 替换为 Officeline 自有品牌。
# 社区版会忽略 editorConfig.customization.logo(白标是付费功能),所以直接替换容器内静态文件。
# 注意:nginx 优先返回预压缩 .gz,必须一并重做;DS 容器重建/镜像升级后需重跑本脚本
# (bootstrap-cloud.sh 已内置调用,重跑 bootstrap 即可)。
set -euo pipefail

C=${1:-deploy-ds-1}
BASE=/var/www/onlyoffice/documentserver/web-apps/apps

wordmark() { # $1=宽 $2=高 $3=字号 $4=颜色
  cat <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$1" height="$2" viewBox="0 0 $1 $2"><text x="1" y="$(($2 * 3 / 4))" font-family="-apple-system,'Segoe UI',Arial,sans-serif" font-size="$3" font-weight="700" fill="$4">Officeline</text></svg>
SVG
}

put() { # $1=svg内容通过stdin $2=容器内路径
  sudo docker exec -i "$C" sh -c "cat > '$1' && gzip -kf '$1'"
}

# 编辑器标题栏(85×20):header-logo_s = 白字(深色栏),dark-logo_s = 深字(浅色栏)
wordmark 85 20 15 '#ffffff' | put "$BASE/common/main/resources/img/header/header-logo_s.svg"
wordmark 85 20 15 '#444444' | put "$BASE/common/main/resources/img/header/dark-logo_s.svg"
# 嵌入/访客视图(85×20,深字)
wordmark 85 20 15 '#444444' | put "$BASE/common/embed/resources/img/logo.svg"
# 「关于」面板大 logo(245×45)
wordmark 245 45 34 '#333333' | put "$BASE/common/main/resources/img/about/logo_s.svg"
wordmark 245 45 34 '#ffffff' | put "$BASE/common/main/resources/img/about/logo-white_s.svg"

# CSS 级覆盖:三个编辑器的 header 品牌背景图直接指向 app 域的自有 logo
# (绕开 SVG 文件在各级缓存中的旧副本;幂等:重复执行不重复追加)
APP_URL=${OFFICELINE_PUBLIC_URL:-https://app.softeah.com}
CSS_OVERRIDE=".header-logo i{background-image:url('$APP_URL/logo-dark.png') !important;background-size:contain !important;background-position:center left !important}.theme-dark .header-logo i,.theme-contrast-dark .header-logo i,.theme-night .header-logo i{background-image:url('$APP_URL/logo-light.png') !important}.header-logo,.header-logo i{pointer-events:none !important;cursor:default !important}"
for app in documenteditor spreadsheeteditor presentationeditor; do
  F="$BASE/$app/main/resources/css/app.css"
  sudo docker exec -i "$C" sh -c "sed -i '/OFFICELINE-BRAND/d' '$F'; printf '\n/*OFFICELINE-BRAND*/%s' \"\$(cat)\" >> '$F'; gzip -kf '$F'" <<<"$CSS_OVERRIDE"
done

# 「关于」面板 publisher 信息(链接/邮箱/电话/显示名)换成自有品牌
# 注意:只改 UI 显示值;文件头的版权声明依 AGPL 保留不动
sudo docker exec -i "$C" python3 - <<PY
import re, gzip
f = "$BASE/common/main/lib/view/About.js"
s = open(f, encoding="utf-8").read()
s = re.sub(r"publishername:\s*'[^']*'", "publishername: 'Officeline'", s)
s = re.sub(r"publisherurl:\s*'[^']*'", "publisherurl: 'https://app.softeah.com'", s)
s = re.sub(r"supportemail:\s*'[^']*'", "supportemail: 'support@softeah.com'", s)
s = re.sub(r"phonenum:\s*'[^']*'", "phonenum: ''", s)
s = re.sub(r"publisheraddr:\s*'[^']*'", "publisheraddr: ''", s)
open(f, "w", encoding="utf-8").write(s)
open(f + ".gz", "wb").write(gzip.compress(s.encode()))
print("About.js publisher 已替换")
PY

echo "✅ DS 品牌补丁完成(浏览器强刷或换个文档可见)"
