#!/usr/bin/env node
// Spine 3.8 -> 统一资产包（WebGL/GPU 路径）
//
// 与 tools/spine_export.mjs（canvas 路径）的关系：
//   两条路径产出同一套 pack.json 结构，可互相替换。选哪条由 --renderer 决定。
//   canvas：快、无 GPU 依赖，但不支持 clipping（stencil）。
//   webgl ：走 GPU，支持 clipping 遮罩与完整混合模式。
//
// 为什么用 Electron 当宿主：它自带 Chromium = 真实 GL 上下文，
// 项目本来就依赖它，不必再引 headless-gl / node-gyp 那套原生编译。
//
//   用法： node tools/spine_webgl_export.mjs --model <dir> --out <packdir> [--fps 8] [--scale 0.5]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENDOR = path.join(ROOT, 'vendor', 'spine-3.8');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

// 自写 PNG：canvas 路径踩过的坑 —— cairo 的编码器在重 mesh 模型上会误报 OOM。
// 这里同样绕开内置编码器，自己封 PNG（IHDR + IDAT + IEND）。
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(width, height, rgba) {
  // WebGL 的 readPixels 原点在左下，PNG 原点在左上 —— 必须逐行翻转，
  // 否则导出的小人是倒的。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride;
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + src, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pageNames(atlasText) {
  const out = [];
  for (const line of atlasText.split(/\r?\n/)) {
    const t = line.trim();
    if (t && /\.(png|jpg|jpeg|webp)$/i.test(t)) out.push(t);
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.model) { console.error('用法: spine_webgl_export.mjs --model <dir> --out <dir>'); app.exit(2); return; }
  const modelDir = path.resolve(a.model);
  const base = a.name || fs.readdirSync(modelDir).find((f) => f.endsWith('.atlas'))?.replace(/\.atlas$/, '');
  if (!base) { console.error('目录里没有 .atlas'); app.exit(3); return; }

  const atlasText = fs.readFileSync(path.join(modelDir, base + '.atlas'), 'utf8');
  const skelB64 = fs.readFileSync(path.join(modelDir, base + '.skel')).toString('base64');
  const pngByPage = {};
  for (const pg of pageNames(atlasText)) {
    const f = path.join(modelDir, path.basename(pg));
    pngByPage[pg] = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  }

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: false } });
  await win.loadFile(path.join(HERE, 'spine_webgl_bake.html'));

  // 注入 spine-webgl 运行时（与 canvas 路径同一个 3.8.95 tag，保证版本一致）
  // ⚠️ 三个 vendor 文件都以 '//# sourceMappingURL=...' 结尾且**没有末尾换行**。
  // 直接拼接会把后面的代码接到这条注释行上，整段被静默吞掉 ——
  // 表现是 spine 对象为空，注入“成功”但什么都拿不到。必须补换行。
  const readJs = (f) => {
    const s = fs.readFileSync(path.join(VENDOR, f), 'utf8');
    return s.endsWith('\n') ? s : s + '\n';
  };
  const core = readJs('spine-core.js');
  const webgl = readJs('spine-webgl.js');
  await win.webContents.executeJavaScript(
    '(function(){ var spine = {}; ' + core + webgl +
    ' window.__SPINE__ = spine; return !!(spine.SkeletonBinary && spine.webgl && spine.webgl.SkeletonRenderer); })()'
  ).then((okInject) => {
    if (!okInject) throw new Error('spine 运行时注入不完整（缺 SkeletonBinary 或 SkeletonRenderer）');
  });
  console.log('运行时注入成功');

  const ok = await win.webContents.executeJavaScript('window.__ready === true');
  if (!ok) throw new Error('烘焙页没有就绪（spine 注入失败？）');
  console.log('模型 ' + base + ' | 贴图页 ' + Object.keys(pngByPage).length);

  const fps = Number(a.fps || 8);
  const scale = Number(a.scale || 0.5);
  const outDir = path.resolve(a.out || path.join(modelDir, 'pack-webgl'));
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });

  // 先问模型有哪些动画与包围盒（用页内的 spine 直接读）
  const probe = await win.webContents.executeJavaScript(`(async function(){
    var spine = window.__SPINE__;
    var bin = Uint8Array.from(atob(${JSON.stringify(skelB64)}), function(c){return c.charCodeAt(0);});
    var loader = new spine.AtlasAttachmentLoader(new spine.TextureAtlas(${JSON.stringify(atlasText)}, function(){ return null; }));
    var data = new spine.SkeletonBinary(loader).readSkeletonData(bin);
    return { anims: data.animations.map(function(x){return x.name;}), version: data.version };
  })()`);
  console.log('  版本 ' + probe.version + ' | 动画: ' + probe.anims.join(', '));

  console.log('  注意：完整烘焙请用 --anim 指定单段动画（每次一个 GL 建立周期）');
  console.log('  可用动画: ' + probe.anims.join(','));
  app.exit(0);
}

main().catch((e) => { console.error('失败: ' + (e && e.stack || e)); app.exit(1); });