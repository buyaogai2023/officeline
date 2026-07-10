# 上架 Mac App Store(云服务原生外壳 + 苹果内购)

Mac 版是**你云端服务的原生外壳**:登录、文件、OnlyOffice 编辑、AI 全部在服务器端;
Mac App 只负责加载云端页面 + 通过 StoreKit 完成苹果内购。付费只走苹果,不需要商户号。

> 前置:云服务必须先上线(域名 + HTTPS)。App 默认地址在 `desktop/main.js` 的 `CLOUD_URL`,
> 上线后改成你的域名(如 `https://app.你的域名`)。开发时用 `OFFICELINE_URL=http://localhost:9130 npm start` 指向本地 server。

## 架构与代码位置

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 桌面外壳 | `desktop/main.js` | 加载 `CLOUD_URL`,不 spawn 子进程(沙盒安全) |
| 内购桥(渲染侧) | `desktop/preload.js` | 给网页注入 `window.officeline.{isMacApp,purchase,restore,getReceipt}` |
| 内购桥(主进程) | `desktop/storekit.js` | 基于 Electron 内置 `inAppPurchase`(StoreKit 封装),无需原生插件 |
| 前端按钮 | `server/public/index.html` | 升级按钮在 Mac 壳内走 StoreKit,Web 端走演示端点;启动静默续期 |
| 服务端校验 | `server/src/server.js` `/api/billing/apple` | verifyReceipt 校验回执 → 按订阅到期写 `plan=pro` |
| 构建配置 | `desktop/package.json` `build.mas` | mas target + entitlements + 描述文件 |
| 授权文件 | `desktop/build/entitlements.mas*.plist` | 沙盒 + 出站网络 + 用户选择文件 |

## 一、Apple 开发者门户(developer.apple.com)

1. **Identifiers → App IDs**:确认/创建 Bundle ID `com.officeline.app`,勾选 **In-App Purchase** capability。
2. **Certificates**:创建两张:
   - `Mac App Distribution`(旧名 3rd Party Mac Developer Application)
   - `Mac Installer Distribution`(旧名 3rd Party Mac Developer Installer)
   下载并双击导入钥匙串。
3. **Profiles**:创建 **Mac App Store** 类型的 Provisioning Profile,关联上面的 App ID 与证书,
   下载后放到 `desktop/build/embedded.provisionprofile`。

## 二、App Store Connect

1. **我的 App → 新建 App**:选 macOS,Bundle ID 选 `com.officeline.app`。
2. **App 内购买项目 → 创建自动续订订阅**:
   - 产品 ID:`com.officeline.pro.monthly`(¥19/月),可再建 `com.officeline.pro.yearly`(年付,给锚点折扣)。
   - 产品 ID 必须与 `.env` 的 `IAP_PRODUCTS` 完全一致。
3. **App 信息 → App 专用共享密钥(App-Specific Shared Secret)**:生成后填到服务器 `.env` 的 `IAP_SHARED_SECRET`。

## 三、服务器配置

在部署机 `deploy/.env` 填(compose 已映射为 `OFFICELINE_*`,见 `docker-compose.cloud.yml`):

```
IAP_SHARED_SECRET=<App 专用共享密钥>
IAP_BUNDLE_ID=com.officeline.app
IAP_PRODUCTS=com.officeline.pro.monthly,com.officeline.pro.yearly
```

然后 `docker compose up -d --force-recreate app`。
**务必确认 `OFFICELINE_ALLOW_DEMO_UPGRADE` 未设为 1**(否则任何人可 POST `/api/billing/upgrade` 白嫖 pro)。

校验流程:客户端 StoreKit 购买 → 拿到 base64 收据 → `POST /api/billing/apple {receipt}` →
服务器打 `buy.itunes.apple.com/verifyReceipt`(沙盒收据自动转 `sandbox.itunes.apple.com`)→
取匹配产品里到期最晚的订阅 → 写 `users.plan/iap_expires_ms/iap_original_txn`。
到期后 `planOf()` 懒惰回落免费;App 每次启动用 `getReceipt()` 静默续期。

## 四、构建与提交

```bash
cd desktop
npm install
npm run dist:mas      # 产出 dist-app/mas/Officeline-<ver>.pkg
```

用 **Transporter**(Mac App Store 免费)或 `xcrun altool`/`notarytool` 上传 `.pkg` 到 App Store Connect,
在网页端填元数据、截图、隐私信息后提交审核。

## 五、内购实现说明(已完成,无需原生插件)

Electron 自带 `inAppPurchase` 模块(StoreKit 的官方封装,MAS 构建里生效),
`desktop/storekit.js` 已用它实现购买/恢复/取收据,收据从 `.app` 包内 `_MASReceipt/receipt` 读出转 base64。

注意事项:
- 购买只在 **MAS 构建**(`npm run dist:mas`)+ App Store/沙盒测试环境里真实可用;
  开发版点「升级」会报产品无效,属预期。
- 沙盒测试:App Store Connect →「用户和访问」→ 沙盒测试员,创建测试 Apple ID,
  在 Mac 上用它登录 App Store 后测试购买(不会真扣款)。

## 备注

- **AGPL 与 App Store**:历史上 GPL/AGPL 与 App Store 条款冲突(VLC 事件),但你是唯一版权人,
  可对 App Store 分发版自行授予例外/双授权,合规无碍。
- **抽成**:苹果抽 30%,加入 Small Business Program(年营收 <100 万美元)后为 15%。
- **多账号防滥用**:`/api/billing/apple` 已按 `original_transaction_id` 拒绝把同一订阅绑到多个账号。
