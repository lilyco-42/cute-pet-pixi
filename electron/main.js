'use strict';
// cute-pet · Electron 主进程
// 职责：透明/无边框/置顶窗口 + 逐像素点击穿透 + 拖动 + 自定义协议托管应用目录
const { app, BrowserWindow, ipcMain, screen, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { ensurePacks } = require('./packs');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_ROOT = path.join(ROOT, 'assets');

let win = null;
let ignoring = null;      // null=未知 true=穿透 false=可交互
let dragging = false;
let dragTimer = null;
let dragOffset = { x: 0, y: 0 };

// 自定义协议：pet://app/...  —— 为了 ES module / fetch / 同源 canvas 读取（file:// 会被 CORS 拦）
protocol.registerSchemesAsPrivileged([
  { scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function servePet(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (!rel || rel === '/') rel = '/src/index.html';
  let full;
  if (rel.startsWith('/vendor/')) full = path.join(ROOT, 'node_modules', rel.slice('/vendor/'.length));
  else full = path.join(ROOT, rel);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(resolved).toString());
}

function applyClickThrough(next) {
  if (next === ignoring) return;
  ignoring = next;
  if (!win || win.isDestroyed()) return;
  if (next) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
  win.webContents.send('pet:click-through-state', next);
}

// 主进程轮询光标 -> 把窗口局部坐标推给渲染层做 alpha 命中测试。
// 为什么不靠 DOM mousemove：窗口一旦处于 passthrough(WS_EX_TRANSPARENT)，就不再直接收鼠标消息，
// 只能指望 Electron 的 forward 鼠标钩子；实测在 Windows 上不保证送达。轮询是确定性的。
let cursorTimer = null;
function startCursorTracking() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (dragging) return;
    const c = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const lx = c.x - wx;
    const ly = c.y - wy;
    if (lx < 0 || ly < 0 || lx >= ww || ly >= wh) return;
    win.webContents.send('pet:cursor', lx, ly);
  }, 16);
}

function petSize() {
  // 窗口尺寸由素材包决定；渲染层起来后会调 pet:resize 精确对齐
  return { width: 160, height: 160 };
}

function createWindow() {
  const { width, height } = petSize();
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width, height,
    x: Math.round(wa.width - width - 90),
    y: Math.round(wa.height - height - 40),
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: process.argv.includes('--no-bridge') ? undefined : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (process.argv.includes('--no-bridge')) {
    // 模拟 Android WebView / 浏览器：没有 window.pet，内容层必须自己降级
    win.webContents.on('console-message', (_e, _lvl, message) => console.log('[page]', message));
  }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const q = [];
  for (const arg of process.argv) {
    if (arg.startsWith('--pack=')) q.push('pack=' + encodeURIComponent(arg.slice(7)));
    else if (arg.startsWith('--face=')) q.push('face=' + encodeURIComponent(arg.slice(7)));
    else if (arg.startsWith('--clip=')) q.push('clip=' + encodeURIComponent(arg.slice(7)));
  }
  win.loadURL('pet://app/src/index.html' + (q.length ? '?' + q.join('&') : ''));
  // 起步即穿透：透明像素永不吃掉桌面点击；命中不透明像素时渲染层会关掉穿透
  applyClickThrough(true);
  startCursorTracking();
  if (process.argv.includes('--capture')) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => { if (win) win.webContents.send('pet:capture'); }, 2500);
      setTimeout(() => { console.log('CAPTURE_TIMEOUT'); app.quit(); }, 12000);
    });
  }
  if (process.argv.includes('--no-bridge-capture')) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();   // 主进程直接截窗口（含 alpha）
          const out = path.join(ROOT, 'docs', 'verify_nobridge.png');
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await fs.promises.writeFile(out, img.toPNG());
          console.log('NOBRIDGE_CAPTURED ' + out);
        } catch (e) { console.log('NOBRIDGE_FAIL ' + (e && e.message)); }
        app.quit();
      }, 3000);
    });
  }
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

ipcMain.on('pet:click-through', (_e, v) => { if (!dragging) applyClickThrough(!!v); });

ipcMain.on('pet:drag-start', () => {
  if (!win) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { x: c.x - wx, y: c.y - wy };
  dragging = true;
  applyClickThrough(false);
  // 主进程轮询光标：窗口跟着光标走时 clientX 会失真，用屏幕坐标最稳
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
  }, 16);
});

ipcMain.on('pet:drag-end', () => {
  dragging = false;
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
});

ipcMain.on('pet:quit', () => app.quit());

// 行为状态机要用的「窗口在哪 + 光标在哪」（屏幕坐标）
ipcMain.handle('pet:probe', () => {
  if (!win || win.isDestroyed()) return null;
  const [wx, wy] = win.getPosition();
  const [ww, wh] = win.getSize();
  const c = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(c);
  return { wx, wy, ww, wh, cx: c.x, cy: c.y, screenW: d.workArea.x + d.workArea.width, screenX: d.workArea.x };
});

ipcMain.on('pet:move-by', (_e, p) => {
  if (!win || win.isDestroyed() || dragging) return;
  const dx = Math.round(Number(p && p.dx) || 0);
  const dy = Math.round(Number(p && p.dy) || 0);
  if (!dx && !dy) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

ipcMain.on('pet:resize', (_e, size) => {
  if (!win || win.isDestroyed()) return;
  const width = Math.max(32, Math.round(size.width));
  const height = Math.max(32, Math.round(size.height));
  const [x, y] = win.getPosition();
  const [ow, oh] = win.getSize();
  win.setBounds({
    x: Math.round(x + (ow - width) / 2),   // 底边中心锚定：换素材不跳位
    y: Math.round(y + (oh - height)),
    width, height,
  });
});

ipcMain.handle('pet:list-dir', async (_e, rel) => {
  const full = path.resolve(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) throw new Error('path escape');
  const entries = await fs.promises.readdir(full, { withFileTypes: true });
  return entries.map((d) => ({ name: d.name, dir: d.isDirectory() }));
});

ipcMain.handle('pet:save-capture', async (_e, dataUrl) => {
  const out = path.join(ROOT, 'docs', 'verify_render.png');
  const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await fs.promises.writeFile(out, Buffer.from(b64, 'base64'));
  return out;
});

ipcMain.handle('pet:log', (_e, line) => { console.log('[renderer]', line); });

// 素材按需拉取（渲染层也可以主动查一次状态）
ipcMain.handle('pet:packs', async () => await ensurePacks({ root: ROOT, log: (m) => console.log('[packs]', m) }));

ipcMain.on('pet:capture-done', (_e, out) => {
  console.log('CAPTURE_SAVED ' + out);
  setTimeout(() => app.quit(), 300);
});

app.commandLine.appendSwitch('enable-transparent-visuals');

app.whenReady().then(async () => {
  protocol.handle('pet', servePet);
  const syncPacks = () => ensurePacks({ root: ROOT, log: (m) => console.log('[packs]', m) });
  if (process.argv.includes('--sync-packs')) {
    const r = await syncPacks();
    console.log('SYNC_RESULT ' + JSON.stringify(r));
    app.quit();
    return;
  }
  createWindow();
  // 后台拉取，不阻塞窗口显示
  syncPacks().catch(() => {});
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
