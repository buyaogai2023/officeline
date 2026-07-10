// StoreKit 桥:Mac App Store 内购的原生入口。
//
// App Store 要求数字订阅必须经 StoreKit 在 App 进程内弹出付款,无法用网页支付替代;
// 且沙盒下不能靠外部子进程弹付款窗,所以这里加载一个"进程内原生 napi 插件"。
//
// 该原生插件需在你的 Mac 上用 Xcode 编译(见 docs/mac-app-store.md「剩余原生接线」),
// 需实现以下契约:
//   purchase(productId: string): Promise<{ receipt: string }>   // base64 App 收据
//   restore(): Promise<{ receipt: string }>
//   getReceipt(): Promise<{ receipt: string | null }>
//
// 未接线时下面的调用会明确报错(不会静默失败),App 其余功能照常可用。
'use strict';

let native = null;
try {
  // 编译产物放这里(或改成你选用的 napi 包名)
  native = require('./native/storekit.node');
} catch {
  native = null;
}

const NOT_WIRED = '内购原生模块未接入。请按 docs/mac-app-store.md 编译 StoreKit napi 插件后重试。';

async function purchase(productId) {
  if (!native) throw new Error(NOT_WIRED);
  if (!productId) throw new Error('缺少产品 ID');
  return native.purchase(productId);
}

async function restore() {
  if (!native) throw new Error(NOT_WIRED);
  return native.restore();
}

async function getReceipt() {
  if (!native) return { receipt: null };
  return native.getReceipt();
}

module.exports = { purchase, restore, getReceipt, available: () => Boolean(native) };
