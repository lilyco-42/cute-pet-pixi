#!/usr/bin/env node
// Spine 3.8 -> 统一资产包 pack.json（离线烘焙成 PNG 帧序列）
//
// 为什么走离线而不是运行时适配：
//   1. Spine 3.8 的 Web 运行时不发布到 npm（@esotericsoftware/spine-canvas/webgl 只从 4.0.1 起），
//      3.8 只能取官方仓库 tag 3.8.95 的预编译产物；而明日方舟模型锁定 3.8。
//   2. Spine Runtimes 授权要求持有 Spine 授权 —— 把运行时依赖关在离线导出器里，
//      发布出去的桌宠运行时就不带任何 Spine 代码。
//   3. 运行时只有一种中间表示，跨平台零格式依赖（桌面/Android/Web 同一份内容层）。
//
// 用法：
//   node tools/spine_export.mjs --model <dir> --out <packdir> [--scale 0.5] [--fps 10] [--anim A,B] [--list]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from 'canvas';

const VENDOR = path.resolve(path.dirname(process.argv[1]), '..', 'vendor', 'spine-3.8');

export function loadSpineRuntime(vendorDir = VENDOR) {
  const core = fs.readFileSync(path.join(vendorDir, 'spine-core.js'), 'utf8');
  const canvas = fs.readFileSync(path.join(vendorDir, 'spine-canvas.js'), 'utf8');
  const sandbox = {
    console,
    navigator: { userAgent: 'node' },
    // 运行时里的 AssetManager 等便利类会碰 document；我们手动构造 TextureAtlas，用不到它们，
    // 但脚本加载阶段不能因为缺对象而炸。
    document: { createElement: () => ({ getContext: () => ({}), style: {}, setAttribute() {} }) },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(core + '\n' + canvas + '\n;this.__spine = spine;', ctx, { filename: 'spine-3.8.95.js' });
  const spine = ctx.__spine;
  if (!spine) throw new Error('Spine 运行时加载失败');
  return spine;
}

function pageNames(atlasText) {
  const out = [];
  for (const line of atlasText.split(/\r?\n/)) {
    const t = line.trim();
    if (t && /\.(png|jpg|jpeg|webp)$/i.test(t)) out.push(t);
  }
  return out;
}

export async function loadModel(spine, modelDir, baseName) {
  const atlasText = fs.readFileSync(path.join(modelDir, baseName + '.atlas'), 'utf8');
  const textures = {};
  for (const p of pageNames(atlasText)) {
    const file = path.join(modelDir, path.basename(p));
    if (!fs.existsSync(file)) throw new Error('atlas 引用的贴图不存在: ' + file);
    const CT = spine.CanvasTexture || (spine.canvas && spine.canvas.CanvasTexture);
    textures[path.basename(p)] = new CT(await loadImage(fs.readFileSync(file)));
  }
  const atlas = new spine.TextureAtlas(atlasText, (p) => textures[path.basename(p)] || textures[p]);
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const skelPath = path.join(modelDir, baseName + '.skel');
  const jsonPath = path.join(modelDir, baseName + '.json');
  let data;
  if (fs.existsSync(skelPath)) {
    // 3.8 的 BinaryInput 读的是 data.buffer（要 typed array，不是 ArrayBuffer），
    // 且 new DataView(data.buffer) 不看 byteOffset —— 必须给 byteOffset=0 的独立 Uint8Array，
    // 否则遇到 Buffer 池化会读错位置。
    data = new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(fs.readFileSync(skelPath)));
  } else if (fs.existsSync(jsonPath)) {
    data = new spine.SkeletonJson(loader).readSkeletonData(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
  } else {
    throw new Error('找不到 .skel 或 .json: ' + modelDir);
  }
  const skeleton = new spine.Skeleton(data);
  // A/B 用：把全部槽位压成 Normal，复现「忽略混合模式」的旧行为
  if (process.argv.includes('--no-blend')) {
    for (const s of data.slots) s.blendMode = 0;
  }
  // Spine 坐标系 Y 轴向上，canvas Y 轴向下；spine-canvas 的 SkeletonRenderer 直接按 skeleton
  // 坐标画，所以整体镜像一次，否则小人是倒立的（实测确认）。
  skeleton.scaleY = -1;
  return { data, skeleton };
}

function makeReset(spine, skeleton, data, name) {
  const sd = new spine.AnimationStateData(data);
  sd.defaultMix = 0;                    // 烘焙时不混合动作，避免帧间糊在一起
  return () => {
    skeleton.setToSetupPose();
    const state = new spine.AnimationState(sd);
    state.setAnimation(0, name, true);
    state.apply(skeleton);
    skeleton.updateWorldTransform();
    return state;
  };
}

const advance = (state, skeleton, fps) => {
  state.update(1 / fps);
  state.apply(skeleton);
  skeleton.updateWorldTransform();
};

export function animationFrameCount(anim, fps, maxFrames) {
  const need = Math.max(1, Math.round(anim.duration * fps));
  return maxFrames > 0 ? Math.min(maxFrames, need) : need;   // 0 = 不截断
}

// 第一遍：只扫包围盒。多段动画必须共用同一个包围盒，
// 否则每段各自裁边 -> 画布尺寸不同 -> 切换动画时角色跳位。
export function scanBounds(spine, skeleton, data, name, fps, maxFrames) {
  const anim = data.findAnimation(name);
  if (!anim) throw new Error('动画不存在: ' + name);
  const total = animationFrameCount(anim, fps, maxFrames);
  const off = new spine.Vector2();
  const size = new spine.Vector2();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const state = makeReset(spine, skeleton, data, name)();
  for (let i = 0; i < total; i++) {
    skeleton.getBounds(off, size, []);
    minX = Math.min(minX, off.x); minY = Math.min(minY, off.y);
    maxX = Math.max(maxX, off.x + size.x); maxY = Math.max(maxY, off.y + size.y);
    advance(state, skeleton, fps);
  }
  return { total, minX, minY, maxX, maxY };
}

// 第二遍：按统一包围盒渲染
export function renderAnimation(spine, skeleton, data, name, opts) {
  const { fps, scale, bounds, total, prefix } = opts;
  const cw = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * scale));
  const ch = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) * scale));
  let canvas = createCanvas(cw, ch);
  let ctx = canvas.getContext('2d');
  const Renderer = (spine.canvas && spine.canvas.SkeletonRenderer) || spine.SkeletonRenderer;
  let renderer = new Renderer(ctx);
  // 重模型（动态立绘：2452² 贴图 / 279 mesh）渲染若干帧后 cairo 侧会 OOM，
  // 与画布尺寸无关、只与累计帧数有关（实测 fps=2 的 8 帧能过、fps=8 的 32 帧挂）。
  // 定期重建 canvas/context/renderer 能把积累的状态释放掉。
  // 默认 0 = 不回收。实测「定期重建 canvas」是负优化：每次 createCanvas 都新增一张
  // cairo surface，node-canvas 不会及时释放，内存只增不减，反而更早 OOM。
  const RECYCLE_EVERY = Math.max(0, Number(opts.recycle || 0));
  // 必须显式打开三角化渲染。spine-canvas 的 SkeletonRenderer 构造函数里
  //   this.triangleRendering = false;
  // 是默认值，于是 draw() 走 drawImages()，而 drawImages 对**非 RegionAttachment 直接 continue**
  // —— 所有 MeshAttachment 被静默丢弃。明日方舟小人大量用 mesh（本模型 15/47），
  // 这就是「人物渲染不全」的根因。pixi-spine（你 client 用的）不存在这个问题。
  renderer.triangleRendering = opts.imagesOnly ? false : true;
  const frames = [];
  const state = makeReset(spine, skeleton, data, name)();
  for (let i = 0; i < total; i++) {
    if (RECYCLE_EVERY > 0 && i > 0 && i % RECYCLE_EVERY === 0) {
      canvas = createCanvas(cw, ch);
      ctx = canvas.getContext('2d');
      renderer = new Renderer(ctx);
      // 必须重设！新 Renderer 的 triangleRendering 又回到默认的 false，
      // 于是从这一帧起 drawImages 把所有 MeshAttachment 静默跳过 ——
      // 表现是首帧正常、后续帧空白（动态立绘 279 个 mesh 全丢）。
      renderer.triangleRendering = opts.imagesOnly ? false : true;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
    // 分段诊断 + 自愈：cairo 在内存曲线完全平坦时也会抛 out of memory，
    // 说明未必真的耗尽内存。把 draw 与 toBuffer 分开捕获，先定位抛在哪一段；
    // 再重建 canvas 重试一次 —— 若失败源于 surface 状态（而非本帧内容），重试就能过。
    let png = null, stage = 'draw';
    for (let attempt = 0; attempt < 2 && png === null; attempt++) {
      if (attempt > 0) {
        canvas = createCanvas(cw, ch);
        ctx = canvas.getContext('2d');
        renderer = new Renderer(ctx);
        renderer.triangleRendering = opts.imagesOnly ? false : true;
        ctx.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
        console.error('RETRY frame=' + i + ' 第 ' + (attempt + 1) + ' 次重建后重试');
      }
      try {
        // 每次尝试都完整重画：round 0 用当前 surface，round 1 用重建后的。
        ctx.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
        renderer.draw(skeleton);
        stage = 'toBuffer';
        // 几何探针：cairo 遇到非有限浮点（NaN/Infinity）时会抛 out of memory，
        // 错误信息极具误导性。在 toBuffer 前扫一遍顶点与骨骼变换，先排除这种可能。
        if (opts.geoProbe) {
          let badV = 0, badB = 0, nAtt = 0, nBone = 0;
          for (const drw of skeleton.drawOrder) {
            const att = drw.attachment;
            if (!att) continue;
            nAtt++;
            for (const key of ['vertices', 'regionUVs', 'uvs']) {
              const arr = att[key];
              if (!arr) continue;
              for (let q = 0; q < arr.length; q++) {
                if (!Number.isFinite(arr[q])) {
                  badV++;
                  if (badV <= 4) console.error('GEO frame=' + i + ' att=' + (att.name || '?') + ' ' + key + '[' + q + ']=' + arr[q]);
                  break;
                }
              }
            }
          }
          for (const b of skeleton.bones) {
            nBone++;
            if (!Number.isFinite(b.a) || !Number.isFinite(b.b) || !Number.isFinite(b.c) || !Number.isFinite(b.d) || !Number.isFinite(b.worldX) || !Number.isFinite(b.worldY)) {
              badB++;
              if (badB <= 4) console.error('GEO frame=' + i + ' bone=' + b.data.name + ' a=' + b.a + ' b=' + b.b + ' c=' + b.c + ' d=' + b.d + ' x=' + b.worldX + ' y=' + b.worldY);
            }
          }
          console.error('GEO frame=' + i + ' 附件=' + nAtt + ' 骨骼=' + nBone + ' 非有限顶点=' + badV + ' 非有限骨骼=' + badB);
        }
        png = canvas.toBuffer('image/png');
      } catch (e) {
        console.error('SEG frame=' + i + ' stage=' + stage + ' canvas=' + cw + 'x' + ch + ' attempt=' + attempt + ' err=' + e.message);
        if (attempt === 1) throw e;
      }
    }
    // 内存探针：区分「逐帧累积」还是「单帧尖峰」。
    // 只有在 --mem-probe N 时才打印，默认零开销。
    if (opts.memProbe && (i % Number(opts.memProbe) === 0 || i === total - 1)) {
      const m = process.memoryUsage();
      console.error("MEM frame=" + i + " rss=" + (m.rss/1048576).toFixed(1) + "M heap=" + (m.heapUsed/1048576).toFixed(1) + "M ext=" + (m.external/1048576).toFixed(1) + "M");
    }
    frames.push({ file: prefix + '_' + String(i).padStart(3, '0') + '.png', canvas: png });
    advance(state, skeleton, fps);
  }
  return { frames, width: cw, height: ch };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.model) { console.error('用法: node tools/spine_export.mjs --model <dir> --out <packdir> [--scale 0.5] [--fps 10] [--anim A,B] [--list]'); process.exit(2); }
  const modelDir = path.resolve(a.model);
  const base = a.name || fs.readdirSync(modelDir).find((f) => f.endsWith('.atlas'))?.replace(/\.atlas$/, '');
  if (!base) { console.error('目录里没有 .atlas'); process.exit(3); }
  const spine = loadSpineRuntime();
  const { data, skeleton } = await loadModel(spine, modelDir, base);
  const names = data.animations.map((x) => x.name);
  console.log('模型 ' + base + ' | 动画 ' + names.length + ' 个: ' + names.join(', '));
  if (a.list) return;

  const fps = Number(a.fps || 10);
  const scale = Number(a.scale || 1);
  // 默认不设帧上限：曾经硬编码 60，把 Sit(8.00s -> 80 帧) 静默截掉 20 帧，
  // 出来的是一个跳回开头的残缺循环。要限就显式 --max-frames，并且会打印警告。
  const maxFrames = Number(a['max-frames'] || 0);
  // 默认导出全部动画：桌宠需要完整的角色动作集，只挑 idle 类会「动作不全」。
  const pick = a.anim ? String(a.anim).split(',') : names.slice();

  const PAD = 2;
  let bounds;
  const plan = [];
  if (a['bounds-json']) {
    // 跨进程共享的包围盒：保证各进程画布尺寸与图层偏移完全一致，合并后切动画不跳位
    bounds = JSON.parse(String(a['bounds-json']));
    for (const name of pick) plan.push({ name, total: animationFrameCount(data.findAnimation(name), fps, maxFrames) });
    console.log('  使用外部包围盒 ' + Math.round(bounds.maxX - bounds.minX) + 'x' + Math.round(bounds.maxY - bounds.minY));
  } else {
    bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const name of pick) {
      const b = scanBounds(spine, skeleton, data, name, fps, maxFrames);
      const need = animationFrameCount(data.findAnimation(name), fps, 0);
      if (b.total < need) console.warn('  ! ' + name + ' 被 --max-frames ' + maxFrames + ' 截断：' + b.total + '/' + need + ' 帧');
      plan.push({ name, total: b.total });
      bounds.minX = Math.min(bounds.minX, b.minX); bounds.minY = Math.min(bounds.minY, b.minY);
      bounds.maxX = Math.max(bounds.maxX, b.maxX); bounds.maxY = Math.max(bounds.maxY, b.maxY);
      console.log('  扫描 ' + name + ': ' + b.total + ' 帧, 自身 bbox ' +
        Math.round(b.maxX - b.minX) + 'x' + Math.round(b.maxY - b.minY));
    }
    bounds = { minX: bounds.minX - PAD, minY: bounds.minY - PAD, maxX: bounds.maxX + PAD, maxY: bounds.maxY + PAD };
  }
  if (a['scan-only']) {
    console.log('BOUNDS ' + JSON.stringify(bounds));
    return;
  }

  const outDir = path.resolve(a.out || path.join(modelDir, 'pack'));
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  const animations = {};
  const ticks = Math.round(60 / fps);
  for (const { name, total } of plan) {
    const res = renderAnimation(spine, skeleton, data, name, {
      fps, scale, bounds, total, prefix: name,
      imagesOnly: !!a['images-only'],   // 诊断开关：复现「只画 region、丢掉 mesh」的旧行为
      recycle: a.recycle,
      memProbe: a['mem-probe'],
      geoProbe: a['geo-probe'],               // 每 N 帧重建 canvas；重 mesh 模型要给 1
    });
    for (const f of res.frames) fs.writeFileSync(path.join(outDir, 'frames', f.file), f.canvas);
    animations[name] = {
      loop: true,
      directions: { '0': { frames: res.frames.map((f) => ({ ticks, layers: [{ src: 'frames/' + f.file, x: 0, y: 0 }] })) } },
    };
    console.log('  ' + name + ': ' + res.frames.length + ' 帧 @ ' + res.width + 'x' + res.height);
  }
  const cw = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * scale));
  const ch = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) * scale));
  // 合帧写入：重 mesh 模型（动态立绘）跨动画的内存累积会把 cairo 顶爆，
  // 所以改成「一段动画一个进程」+ 共享包围盒，最后在这里合并 animations。
  const pjPath = path.join(outDir, 'pack.json');
  let merged = null;
  if (a.merge && fs.existsSync(pjPath)) {
    try { merged = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch (e) { merged = null; }
  }
  if (merged) {
    Object.assign(merged.animations, animations);
    merged.canvas = { width: cw, height: ch };
    fs.writeFileSync(pjPath, JSON.stringify(merged, null, 2));
    console.log('合并写入 ' + pjPath + '（共 ' + Object.keys(merged.animations).length + ' 段动画）');
    return;
  }
  const pack = {
    schema: 1, id: a.id || ('spine.' + base), format: 'frames',
    canvas: { width: cw, height: ch }, scale: 1,
    anchor: { x: 0.5, y: 1.0 }, hitThreshold: 90,
    source: {
      kind: 'spine',
      note: 'Spine 3.8 离线烘焙（tools/spine_export.mjs，运行时 3.8.95）；' +
        'Spine Runtimes 需持有 Spine 授权；角色素材版权归原作者/发行商，不随本项目分发',
      model: base, spineRuntime: '3.8.95',
    },
    animations,
  };
  fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify(pack, null, 2));
  console.log('pack.json -> ' + path.join(outDir, 'pack.json') + '  统一画布 ' + cw + 'x' + ch + ' / ticks=' + ticks);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('失败: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
}
