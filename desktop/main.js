// Officeline 桌面壳(Mac App Store 版):你的云服务的原生外壳 + 苹果内购
// 沙盒安全:不 spawn 任何子进程,只加载云端 https 服务并注入 StoreKit 购买桥。
'use strict';
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const storekit = require('./storekit');

// 正式云端地址(softeah.com 在 GoDaddy);开发时用 OFFICELINE_URL=http://localhost:9130 指向本地 server。
const CLOUD_URL = process.env.OFFICELINE_URL || 'https://app.softeah.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 1360, height: 860,
    title: 'Officeline',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const base = new URL(CLOUD_URL);
  // 站内链接在应用内新窗口打开;站外链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === base.origin) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1360, height: 860, title: 'Officeline' } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(CLOUD_URL);
}

// 渲染进程发起内购:调 StoreKit 购买 → 返回回执给页面,页面再 POST 给 /api/billing/apple 校验
ipcMain.handle('officeline:purchase', async (_e, productId) => storekit.purchase(productId));
ipcMain.handle('officeline:restore', async () => storekit.restore());
ipcMain.handle('officeline:receipt', async () => storekit.getReceipt());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
