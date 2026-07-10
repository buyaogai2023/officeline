// 注入到云端页面:告诉网页"你正跑在 Mac App 里",并暴露内购能力。
// 网页据此把"升级专业版"按钮改走 StoreKit(App Store 要求数字商品必须走内购,不能用网页支付)。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeline', {
  isMacApp: true,
  // 发起订阅购买;成功后返回 base64 回执(App Store 收据),网页再 POST /api/billing/apple 校验
  purchase: (productId) => ipcRenderer.invoke('officeline:purchase', productId),
  // 恢复购买(换机/重装)
  restore: () => ipcRenderer.invoke('officeline:restore'),
  // 取当前 App 收据(用于启动时静默续期校验)
  getReceipt: () => ipcRenderer.invoke('officeline:receipt'),
});
