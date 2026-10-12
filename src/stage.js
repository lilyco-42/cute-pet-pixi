import * as PIXI from '/vendor/pixi.js/dist/pixi.mjs';
import { hitTestLayers } from './hitmask.js';

// 统一帧/层模型播放器。
//   frames   : animations[id].directions[dir].frames[] = { ticks, layers[] }，ticks 单位 1/60s（与 laic 的 crf60 同源）
//   variants : 可交互分层立绘，场景 = dress 层 ++ face 层，按 z 稳定排序
//               z 规则照抄原 Rust 实现：2=髤かぶせ / 1=表情组 / 3=其它非 0 组(泪·腮红) / 0=身体服装
//
// 贴图**惰性加载**：DesktopSeyana 那个包有 3136 帧 / 38.6MB，一次性预加载会让首帧迟迟不出来
// （实测直接撞上截图超时）。现在只预载「每个 clip 的首帧」和变体选项，其余播到哪载到哪。
export class PetStage {
  constructor(app, pack) {
    this.app = app;
    this.pack = pack;
    this.root = new PIXI.Container();
    this.root.scale.set(pack.scale);
    app.stage.addChild(this.root);
    this.bitmaps = new Map();
    this.pending = new Set();
    this.frames = new Map();
    this.sprites = [];
    this.clipKey = null;
    this.index = 0;
    this.elapsed = 0;
    this.bob = 0;
    this.time = 0;
    this.selection = {};
    this._sceneCache = null;
  }

  _collectFirstFrames(out) {
    for (const clip of Object.values(this.pack.animations)) {
      for (const seq of Object.values(clip.directions)) {
        const f = seq.frames && seq.frames[0];
        if (f) for (const l of f.layers) out.add(l.src);
      }
    }
  }

  async build() {
    for (const [id, clip] of Object.entries(this.pack.animations)) {
      for (const [dir, seq] of Object.entries(clip.directions)) this.frames.set(id + '|' + dir, seq.frames);
    }
    if (this.pack.variants) {
      for (const [name, group] of Object.entries(this.pack.variants)) {
        this.selection[name] = group.default || (group.options[0] && group.options[0].id);
      }
    }

    const preload = new Set();
    if (this.pack.variants) {
      // 变体包层数不多（且大量共享贴图），全量载掉最稳
      for (const group of Object.values(this.pack.variants)) {
        for (const o of group.options) for (const l of o.layers) preload.add(l.src);
      }
    }
    this._collectFirstFrames(preload);
    await Promise.all([...preload].map((s) => this._ensure(s)));

    let maxLayers = 1;
    for (const clip of Object.values(this.pack.animations)) {
      for (const seq of Object.values(clip.directions)) for (const f of seq.frames) maxLayers = Math.max(maxLayers, f.layers.length);
    }
    if (this.pack.variants) {
      let n = 0;
      for (const group of Object.values(this.pack.variants)) n += Math.max(...group.options.map((o) => o.layers.length));
      maxLayers = Math.max(maxLayers, n);
    }
    for (let i = 0; i < maxLayers; i++) {
      const s = new PIXI.Sprite();
      s.anchor.set(0, 0);
      s.visible = false;
      this.root.addChild(s);
      this.sprites.push(s);
    }
    this._apply();
    return this;
  }

  async _ensure(src) {
    if (this.bitmaps.has(src)) return this.bitmaps.get(src);
    if (this.pending.has(src)) return null;
    this.pending.add(src);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('asset 404: ' + src);
      const bmp = await createImageBitmap(await res.blob());
      this.bitmaps.set(src, bmp);
      // 载完的正好是当前场景要用的 -> 立刻补画
      if (this.scene().some((l) => l.src === src)) this._apply();
      return bmp;
    } catch (err) {
      console.warn('[stage]', err && err.message ? err.message : err);
      return null;
    } finally {
      this.pending.delete(src);
    }
  }

  clipIds() { return Object.keys(this.pack.animations); }
  variantIds() { return this.pack.variants ? Object.keys(this.pack.variants) : []; }

  optionOf(group, id) {
    const g = this.pack.variants && this.pack.variants[group];
    if (!g) return null;
    return g.options.find((o) => o.id === id) || null;
  }

  setVariant(group, id) {
    if (!this.pack.variants || !this.pack.variants[group]) return false;
    this.selection[group] = id;
    this._sceneCache = null;
    this._apply();
    return true;
  }

  cycleVariant(group, step) {
    const g = this.pack.variants && this.pack.variants[group];
    if (!g || !g.options.length) return null;
    const cur = g.options.findIndex((o) => o.id === this.selection[group]);
    const next = ((cur < 0 ? 0 : cur) + step + g.options.length) % g.options.length;
    this._sceneCache = null;
    this.selection[group] = g.options[next].id;
    this._apply();
    return g.options[next];
  }

  // 播放某个 clip。贴图不阻塞：先显示已就绪的帧，其余在后台边播边载。
  play(id, dir) {
    const clip = this.pack.animations[id];
    if (!clip) return false;
    const dirs = Object.keys(clip.directions);
    const useDir = dir && clip.directions[dir] ? dir : dirs[0];
    this.clipKey = id + '|' + useDir;
    this.index = 0;
    this.elapsed = 0;
    this._sceneCache = null;
    const seq = clip.directions[useDir];
    for (const f of seq.frames) for (const l of f.layers) this._ensure(l.src);
    this._apply();
    return true;
  }

  scene() {
    if (this._sceneCache) return this._sceneCache;
    let layers;
    if (this.pack.variants) {
      const dress = this.optionOf('dress', this.selection.dress);
      const face = this.optionOf('face', this.selection.face);
      layers = [];
      if (dress) layers.push(...dress.layers);
      if (face) layers.push(...face.layers);
      layers = layers.map((l, i) => [l, i])
        .sort((a, b) => (a[0].z - b[0].z) || (a[1] - b[1]))
        .map(([l]) => l);
    } else {
      const frames = this.frames.get(this.clipKey);
      layers = frames ? frames[this.index].layers : [];
    }
    this._sceneCache = layers;
    return layers;
  }

  currentFrame() {
    const frames = this.frames.get(this.clipKey);
    return frames ? frames[this.index] : null;
  }

  // 一个 clip 播完一轮要多久（秒）。行为状态机用它算「播 N 次」的时长。
  clipDuration(id) {
    const clip = this.pack.animations[id];
    if (!clip) return 0;
    let max = 0;
    for (const seq of Object.values(clip.directions)) {
      let t = 0;
      for (const f of seq.frames) t += Math.max(1, f.ticks | 0) / 60;
      max = Math.max(max, t);
    }
    return max;
  }

  // 左右翻转：绕画布中线镜像，否则角色会被翻到画布外面去
  setFlip(v) {
    const s = Math.abs(this.pack.scale || 1);
    const w = this.pack.canvas.width * s;
    this.flipped = !!v;
    this.root.scale.x = v ? -s : s;
    this.root.x = v ? w : 0;
  }

  _apply() {
    const layers = this.scene();
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      const l = layers[i];
      if (!l) { s.visible = false; continue; }
      const bmp = this.bitmaps.get(l.src);
      if (!bmp) { s.visible = false; this._ensure(l.src); continue; }
      s.visible = true;
      s.texture = PIXI.Texture.from(bmp);
      s.position.set(l.x, l.y);
      s.setSize(l.w || bmp.width, l.h || bmp.height);
      s.alpha = l.alpha;
    }
  }

  update(dtSeconds) {
    this.time += dtSeconds;
    if (this.pack.variants) {
      const idle = this.pack.idle || { bobAmplitude: 0, bobSpeed: 1 };
      this.bob = Math.sin(this.time * (idle.bobSpeed || 0)) * (idle.bobAmplitude || 0);
      this.root.y = this.bob;
      return;
    }
    const frames = this.frames.get(this.clipKey);
    if (!frames || frames.length < 2) return;
    this.elapsed += dtSeconds;
    let guard = 0;
    while (guard++ < 8) {
      const hold = Math.max(1, frames[this.index].ticks | 0) / 60;
      if (this.elapsed < hold) break;
      this.elapsed -= hold;
      this.index = (this.index + 1) % frames.length;
      this._sceneCache = null;
      this._apply();
    }
  }

  hitTest(clientX, clientY) {
    const s = this.pack.scale || 1;
    let cx = clientX / s;
    if (this.flipped) cx = this.pack.canvas.width - cx;
    const cy = (clientY - this.bob) / s;
    return hitTestLayers(this.scene(), this.bitmaps, cx, cy, this.pack.hitThreshold || 90, (l) => this.bitmaps.get(l.src));
  }

  label() {
    if (!this.pack.variants) return this.pack.id;
    const parts = Object.entries(this.selection).map(([k, v]) => k + '=' + v);
    return this.pack.id + ' ' + parts.join(' ');
  }
}
