// Officeline 桌面壳:启动内置服务端并加载主界面
'use strict';
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.OFFICELINE_PORT || 9130);
const HOME = `http://localhost:${PORT}`;
let serverProc = null;

function ping() {
  return new Promise((resolve) => {
    http.get(HOME, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false));
  });
}

async function ensureServer() {
  if (await ping()) return; // 已有服务(开发时手动启动)则复用
  // 开发时用仓库里的 server;打包后 server 在 resources 里(见 package.json extraResources)
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'src', 'server.js')
    : path.join(__dirname, '..', 'server', 'src', 'server.js');
  serverProc = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OFFICELINE_DATA: path.join(app.getPath('userData'), 'data'),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('内置服务启动失败');
}

async function createWindow() {
  await ensureServer();
  const win = new BrowserWindow({
    width: 1360, height: 860,
    title: 'Officeline',
    webPreferences: { contextIsolation: true },
  });
  // 编辑器在应用内新窗口打开;外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(HOME)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1360, height: 860, title: 'Officeline' } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(HOME);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('quit', () => { if (serverProc) serverProc.kill(); });
