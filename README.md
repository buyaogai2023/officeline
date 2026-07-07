# Officeline

自有品牌的云文档办公套件(Windows / macOS)。编辑器内核使用 ONLYOFFICE Document Server(AGPLv3,商业闭源发布前需购买 Developer Edition 授权),云存档、版本历史、账号订阅、AI 助手为自研。

## 架构

```
desktop/          Electron 桌面壳(加载 http://localhost:9130)
server/           云后端(零外部依赖:node:http + node:sqlite)
  src/server.js   全部 API
  public/         Web 界面(登录/文件列表/AI 助手)
  templates/      新建文档用的空白 docx/xlsx/pptx
  data/           运行数据(SQLite + 文件版本),已 gitignore
ONLYOFFICE Document Server   Docker 容器,端口 8080
```

数据流:桌面壳 → 本地后端(9130)⇄ Document Server(8080,容器内经 host.docker.internal 回访 9130 拉取/保存文档)。

## 启动

```bash
# 1. Document Server(镜像已缓存)
colima start
docker start officeline-ds 2>/dev/null || bash deploy/setup-ds.sh
# 注意:重建容器必须走 setup-ds.sh —— 它会打"允许私网地址"补丁,
# 否则 DS 无法回访本机 9130 拉取文档(转换/打开报错 -4)

# 2. 后端
node server/src/server.js        # http://localhost:9130

# 3. 桌面版(或直接用浏览器打开 9130)
cd desktop && npm start
```

## 已实现

- 账号:注册 / 登录(scrypt + HMAC token)
- 云存档:上传、新建(docx/xlsx/pptx)、每次保存自动生成新版本、历史版本查看与无损恢复、软删除
- 订阅:免费版 2GB 云空间 + 每月 20 次 AI / 专业版 100GB + 1000 次,超额返回 402(支付网关是 TODO,现为一键演示升级)
- 编辑:ONLYOFFICE 全功能编辑器,自动保存 + Ctrl+S 强制保存回写云端
- AI:润色 / 总结 / 翻译 / 表格公式,按月计量,DeepSeek(OpenAI 兼容)代理,未配 key 时为演示模式
- 存储驱动:local(默认)/ s3(Cloudflare R2 / MinIO / AWS,零依赖 SigV4 实现,已用 MinIO 全链路验证)

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OFFICELINE_PORT` | 9130 | 后端端口 |
| `OFFICELINE_DS_PUBLIC` | http://localhost:8080 | 浏览器访问 DS 的地址 |
| `OFFICELINE_SELF_FOR_DS` | http://host.docker.internal:9130 | DS 回访后端的地址 |
| `OFFICELINE_AI_KEY` | (空=演示模式) | DeepSeek API Key |
| `OFFICELINE_AI_BASE` / `OFFICELINE_AI_MODEL` | api.deepseek.com / deepseek-chat | 可换任意 OpenAI 兼容服务 |
| `OFFICELINE_STORAGE` | local | 设为 `s3` 走对象存储 |
| `OFFICELINE_S3_ENDPOINT/BUCKET/KEY/SECRET/REGION` | — | s3 模式必填(REGION 默认 auto,R2 用 auto) |

云端部署模板见 `deploy/docker-compose.cloud.yml`。

## 上线前 TODO(按优先级)

1. 存储层从本地磁盘换成 S3 兼容对象存储(Cloudflare R2,接口已按"写版本文件"收敛在 `saveVersion`/`createFile`)
2. 接支付(海外 Paddle/LemonSqueezy,国内需公司主体 + 微信/支付宝)替换 `/api/billing/upgrade` 演示逻辑
3. 云端部署 Document Server + 开启 JWT(`JWT_ENABLED=true` 并在 config 签名)
4. Electron 打包分发(electron-builder,Win 需代码签名证书)
5. ONLYOFFICE 商业授权(闭源发布前)
