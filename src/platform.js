// 宿主平台抽象：同一份内容层要跑在三个环境里
//   electron : Electron 主进程窗口（preload 暴露 window.pet）
//   webview  : Android WebView 壳（addJavascriptInterface 注入 window.PetBridge）
//   browser  : 纯浏览器 / Pages 演示（没有宿主，一切降级为 no-op）
//
// 桥协议沿用 cute-pet 既有约定：
//   JS -> Native : window.PetBridge.postMessage(JSON.stringify({ id, method, params }))
//   Native -> JS : window.PetNative.onMessage({ event, ... })

const hasElectron = typeof window.pet !== 'undefined' && window.pet !== null;
const hasBridge = typeof window.PetBridge !== 'undefined' && window.PetBridge !== null &&
  typeof window.PetBridge.postMessage === 'function';

export const mode = hasElectron ? 'electron' : (hasBridge ? 'webview' : 'browser');

let seq = 1;
function call(method, params) {
  if (!hasBridge) return;
  try {
    window.PetBridge.postMessage(JSON.stringify({ id: seq++, method, params: params || {} }));
  } catch (err) {
    console.warn('[platform] postMessage 失败', err);
  }
}

export const pet = {
  mode,

  setClickThrough(value) {
    if (hasElectron) window.pet.setClickThrough(value);
    else call('setClickThrough', { value: !!value });
  },

  dragStart() {
    if (hasElectron) window.pet.dragStart();
    else call('dragStart');
  },

  dragEnd() {
    if (hasElectron) window.pet.dragEnd();
    else call('dragEnd');
  },

  quit() {
    if (hasElectron) window.pet.quit();
    else call('quit');
  },

  // 传进来的是 CSS 像素（画布尺寸）。Electron 的窗口尺寸单位是 DIP，1:1；
  // Android 的 WindowManager 用的是物理像素，要乘 devicePixelRatio，否则会被裁掉或缩掉。
  resize(width, height) {
    const scale = (mode === 'webview') ? (window.devicePixelRatio || 1) : 1;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (hasElectron) window.pet.resize(w, h);
    else call('resize', { width: w, height: h });
  },

  // 窗口/光标探测，只有 Electron 宿主有（Android 没有光标，返回 null 让追光标类状态自动跳过）
  async probe() {
    if (hasElectron) return await window.pet.probe();
    return null;
  },

  moveBy(dx, dy) {
    if (hasElectron) window.pet.moveBy(dx, dy);
    else call('moveBy', { dx, dy });
  },

  log(line) {
    const text = String(line);
    if (hasElectron) { window.pet.log(text); return; }
    if (hasBridge) { call('log', { line: text }); return; }
    console.log('[pet:' + mode + ']', text);
  },

  // 光标/触摸位置推送。Electron 由主进程轮询喂；WebView 由原生侧在 touch 时喂；
  // 浏览器没有宿主 —— 靠 boot.js 里同时挂的 DOM 事件兜底。
  onCursor(cb) {
    if (hasElectron) { window.pet.onCursor(cb); return; }
    const native = window.PetNative;
    if (!native) return;
    const prev = native.onMessage;
    native.onMessage = function (msg) {
      if (msg && msg.event === 'cursor') cb(msg.x, msg.y);
      if (typeof prev === 'function') prev(msg);
    };
  },

  onCapture(cb) {
    if (hasElectron) { window.pet.onCapture(cb); return; }
    const native = window.PetNative;
    if (!native) return;
    const prev = native.onMessage;
    native.onMessage = function (msg) {
      if (msg && msg.event === 'capture') cb();
      if (typeof prev === 'function') prev(msg);
    };
  },

  captureDone(out) { if (hasElectron) window.pet.captureDone(out); else call('captureDone', { path: String(out) }); },
  async saveCapture(dataUrl) {
    if (hasElectron) return await window.pet.saveCapture(dataUrl);
    call('saveCapture', { dataUrl });
    return '(sent-to-native)';
  },
};
