import * as PIXI from '/vendor/pixi.js/dist/pixi.mjs';
import { loadPack } from './assets/pack.js';
import { PetStage } from './stage.js';
import { pet, mode } from './platform.js';
import { Behavior } from './behavior.js';

const params = new URLSearchParams(location.search);
const PACK_URL = params.get('pack') || '/assets/packs/chibi/pack.json';
const START_FACE = params.get('face');
const START_CLIP = params.get('clip');

async function main() {
  const pack = await loadPack(PACK_URL);
  const app = new PIXI.Application();
  await app.init({
    width: Math.round(pack.canvas.width * pack.scale),
    height: Math.round(pack.canvas.height * pack.scale),
    backgroundAlpha: 0,
    antialias: false,
    resolution: 1,
    autoDensity: false,
    powerPreference: 'low-power',
  });
  document.body.appendChild(app.canvas);

  const stage = await new PetStage(app, pack).build();
  if (pack.variants) {
    if (START_FACE) stage.setVariant('face', START_FACE);
  } else {
    const clips = stage.clipIds();
    stage.play(START_CLIP && clips.includes(START_CLIP) ? START_CLIP : (clips.includes('idle') ? 'idle' : clips[0]));
  }

  pet.resize(app.canvas.width, app.canvas.height);

  // ---- 日常活动状态机（行为表在资产包里）----
  let behavior = null;
  if (pack.behaviors && !pack.variants) {
    behavior = new Behavior(stage, pet, pack.behaviors, (m) => pet.log(m));
    if (START_CLIP) behavior.enter(START_CLIP, 'cli');
  }
  let probeAcc = 0;
  let probing = false;
  app.ticker.add((t) => {
    const dt = t.deltaMS / 1000;
    stage.update(dt);
    if (!behavior) return;
    // 追光标要靠「窗口在哪 + 光标在哪」，主进程 10Hz 推一次够了
    probeAcc += dt;
    if (probeAcc >= 0.1 && !probing) {
      probeAcc = 0;
      probing = true;
      Promise.resolve(pet.probe())
        .then((p) => { behavior.probe = p; })
        .catch(() => {})
        .finally(() => { probing = false; });
    }
    behavior.update(dt);
  });
  window.__behavior = behavior;

  // ---- 逐像素命中 -> 穿透 ----
  // Electron：主进程轮询光标（穿透状态下 DOM 收不到鼠标消息）
  // WebView：原生侧在 touch 时推坐标
  // 浏览器：只有 DOM 事件，作为快路径保留
  let passthrough = true;
  let dragging = false;
  const applyHit = (x, y) => {
    if (dragging) return;
    const hit = stage.hitTest(x, y);
    const want = !hit;
    if (want === passthrough) return;
    passthrough = want;
    pet.setClickThrough(want);
  };
  window.addEventListener('mousemove', (e) => applyHit(e.clientX, e.clientY));
  window.addEventListener('touchmove', (e) => {
    const t0 = e.touches && e.touches[0];
    if (t0) applyHit(t0.clientX, t0.clientY);
  }, { passive: true });
  pet.onCursor((x, y) => applyHit(x, y));

  const startDrag = (x, y) => {
    if (!stage.hitTest(x, y)) return false;
    dragging = true;
    passthrough = false;
    pet.setClickThrough(false);
    pet.dragStart();
    return true;
  };
  window.addEventListener('mousedown', (e) => { if (e.button === 0) startDrag(e.clientX, e.clientY); });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; pet.dragEnd(); } });
  window.addEventListener('touchstart', (e) => {
    const t0 = e.touches && e.touches[0];
    if (t0 && startDrag(t0.clientX, t0.clientY)) e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchend', () => { if (dragging) { dragging = false; pet.dragEnd(); } });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pet.quit(); return; }
    if (e.key >= '1' && e.key <= '9') {
      if (pack.variants) {
        const group = pack.variants.face;
        const opt = group && group.options[Number(e.key) - 1];
        if (opt) { stage.setVariant('face', opt.id); logState(); }
      } else {
        const clips = stage.clipIds();
        if (clips[Number(e.key) - 1]) { stage.play(clips[Number(e.key) - 1]); logState(); }
      }
    } else if (!pack.variants && (e.key === 'n' || e.key === 'N')) {
      const clips = stage.clipIds();
      const i = clips.indexOf(stage.clipKey ? stage.clipKey.split('|')[0] : '');
      stage.play(clips[(i + 1) % clips.length]);
      logState();
    } else if (pack.variants && (e.key === 'd' || e.key === 'D')) {
      if (stage.cycleVariant('dress', 1)) logState();
    } else if (pack.variants && (e.key === 'f' || e.key === 'F')) {
      if (stage.cycleVariant('face', 1)) logState();
    }
  });
  const logState = () => pet.log('state: ' + stage.label());

  pet.onCapture(async () => {
    try {
      app.renderer.render(app.stage);
      const canvas = app.renderer.extract.canvas(app.stage);
      const out = await pet.saveCapture(canvas.toDataURL('image/png'));
      pet.captureDone(out);
    } catch (err) {
      pet.log('CAPTURE_FAIL ' + (err && err.message ? err.message : err));
      pet.captureDone('FAILED');
    }
  });

  window.__pet = { app, stage, pack, mode };
  pet.log('ready[' + mode + ']: ' + stage.label() + ' window=' + app.canvas.width + 'x' + app.canvas.height);
}

main().catch((err) => pet.log('FATAL ' + (err && err.stack ? err.stack : err)));
