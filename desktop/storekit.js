// StoreKit 桥:Mac App Store 内购,基于 Electron 内置 inAppPurchase 模块(无需原生插件)。
// 注意:inAppPurchase 仅在 MAS 构建(npm run dist:mas)里真正可用;
// 开发/dmg 版没有 App Store 环境,购买会失败,但不影响其余功能。
//
// 契约(preload/main 依赖):
//   purchase(productId): Promise<{ receipt: string }>   // base64 App 收据
//   restore():           Promise<{ receipt: string }>
//   getReceipt():        Promise<{ receipt: string | null }>
'use strict';
const { inAppPurchase } = require('electron');
const fs = require('node:fs');

function readReceiptB64() {
  // MAS 收据固定在 .app 包内 _MASReceipt/receipt;购买/恢复成功后必然存在
  const p = inAppPurchase.getReceiptURL();
  const file = p.startsWith('file://') ? new URL(p).pathname : p;
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file).toString('base64');
}

// 等待与 productId 相关的交易落定;购买弹窗可能停留很久,故不设超时(用户取消会收到 failed)
function waitTransaction(productId, states) {
  return new Promise((resolve, reject) => {
    const listener = (_e, transactions) => {
      for (const t of transactions) {
        if (productId && t.payment.productIdentifier !== productId) continue;
        if (states.includes(t.transactionState)) {
          inAppPurchase.finishTransactionByDate(t.transactionDate);
          inAppPurchase.removeListener('transactions-updated', listener);
          const receipt = readReceiptB64();
          if (receipt) resolve({ receipt });
          else reject(new Error('交易完成但未找到收据'));
          return;
        }
        if (t.transactionState === 'failed') {
          inAppPurchase.finishTransactionByDate(t.transactionDate);
          inAppPurchase.removeListener('transactions-updated', listener);
          reject(new Error(t.errorMessage || '购买已取消'));
          return;
        }
      }
    };
    inAppPurchase.on('transactions-updated', listener);
  });
}

async function purchase(productId) {
  if (!productId) throw new Error('缺少产品 ID');
  if (!inAppPurchase.canMakePayments()) throw new Error('当前账户不允许付款(家长控制或未登录 App Store)');
  const done = waitTransaction(productId, ['purchased', 'restored']);
  const ok = await inAppPurchase.purchaseProduct(productId, 1);
  if (!ok) throw new Error(`产品 ${productId} 无效(确认 App Store Connect 已创建且已过「准备提交」)`);
  return done;
}

async function restore() {
  const done = waitTransaction(null, ['restored']);
  inAppPurchase.restoreCompletedTransactions();
  // 无历史购买时 Apple 不回任何交易,给个兜底超时
  return Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('没有可恢复的购买')), 30000)),
  ]);
}

async function getReceipt() {
  try { return { receipt: readReceiptB64() }; }
  catch { return { receipt: null }; }
}

module.exports = { purchase, restore, getReceipt };
