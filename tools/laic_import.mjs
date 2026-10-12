#!/usr/bin/env node
// laic (Alice in Cradle / PixelLiner) -> 统一资产包 pack.json
//
// laic 的输出契约（已核对 lilyco-aic 源码 render.rs / animate.rs）：
//   单帧 PNG : <out>/<table>.<pose_tag>.d<dir>.f<frame>.png
//   循环 GIF : <out>/<table>.<pose_tag>.d<dir>.gif
//   精灵表   : <out>/<table>.<pose_tag>.sheet.png   (行=方向, 列=帧)
//   帧时长   : 每帧 crf60 个 1/60s tick，来自 `laic frame --json`
//              -> { matches:[{ file, pose, dirs:[{ dir, frames:[{ index, name, crf60 }] }] }] }
//
// 用法：
//   1) 已有渲染结果： node tools/laic_import.mjs --render-dir ./out --frame-json ./frames.json --out assets/packs/noel
//   2) 直接调 laic  ： node tools/laic_import.mjs --run-laic <xxx.pxls.dat> --pose "walk*" --out assets/packs/noel
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

// laic 的文件名：<table>.<pose_tag>.d<dir>.f<idx>.png
export function parseLaicName(name) {
  const m = /\.d(\d+)\.f(\d+)\.png$/.exec(name);
  if (!m) return null;
  const stem = name.slice(0, m.index);
  const dot = stem.indexOf('.');
  if (dot < 0) return null;
  return { table: stem.slice(0, dot), pose: stem.slice(dot + 1), dir: Number(m[1]), index: Number(m[2]) };
}

// 最小 PNG 头解析（读 IHDR），避免为一个尺寸引入依赖
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function buildPack(records, crf60Map, opts = {}) {
  const byPose = new Map();
  let canvas = { width: 0, height: 0 };
  for (const r of records) {
    if (r.size) canvas = { width: Math.max(canvas.width, r.size.width), height: Math.max(canvas.height, r.size.height) };
    const key = r.table + '\u0000' + r.pose;
    if (!byPose.has(key)) byPose.set(key, new Map());
    const dirs = byPose.get(key);
    if (!dirs.has(r.dir)) dirs.set(r.dir, []);
    dirs.get(r.dir).push(r);
  }
  const animations = {};
  for (const [key, dirs] of byPose) {
    const [table, pose] = key.split('\u0000');
    const id = (opts.prefix ? opts.prefix + '.' : '') + pose;
    const directions = {};
    for (const [dir, list] of dirs) {
      list.sort((a, b) => a.index - b.index);
      directions[String(dir)] = {
        frames: list.map((r) => {
          const ticks = crf60Map.get(table + '|' + pose + '|' + r.dir + '|' + r.index);
          return { ticks: ticks === undefined ? (opts.defaultTicks || 4) : ticks, name: r.name || null, layers: [{ src: r.file, x: 0, y: 0 }] };
        }),
      };
    }
    animations[id] = { loop: true, directions };
  }
  return {
    schema: 1,
    id: opts.id || 'laic.pack',
    format: 'frames',
    canvas,
    anchor: { x: 0.5, y: 1.0 },
    hitThreshold: 90,
    source: { kind: 'laic', note: 'Alice in Cradle / PixelLiner，由 tools/laic_import.mjs 归一化' },
    animations,
  };
}

export function crf60Index(frameJson) {
  const map = new Map();
  for (const match of (frameJson && frameJson.matches) || []) {
    const pose = match.pose;
    const stem = path.basename(String(match.file || '')).replace(/\.pxls(\.dat|\.bytes)?$/, '');
    for (const d of match.dirs || []) {
      for (const f of d.frames || []) map.set(stem + '|' + pose + '|' + d.dir + '|' + f.index, f.crf60);
    }
  }
  return map;
}

function scanDir(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const parsed = parseLaicName(name);
    if (!parsed) continue;
    const size = pngSize(fs.readFileSync(path.join(dir, name)));
    out.push({ ...parsed, file: name, size });
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  let renderDir = a['render-dir'];
  let frameJson = null;
  if (a['run-laic']) {
    renderDir = renderDir || path.join(process.cwd(), '.laic-out');
    fs.mkdirSync(renderDir, { recursive: true });
    const pose = a.pose || '*';
    const r1 = spawnSync('laic', ['render', '--root', a['run-laic'], '--out', renderDir, '--pose', pose], { stdio: 'inherit' });
    if (r1.status !== 0) { console.error('laic render 失败，退出码 ' + r1.status); process.exit(r1.status || 1); }
    const r2 = spawnSync('laic', ['frame', '--root', a['run-laic'], '--pose', pose, '--json'], { encoding: 'utf8' });
    if (r2.status === 0) { frameJson = JSON.parse(r2.stdout); }
  }
  if (!renderDir) { console.error('需要 --render-dir 或 --run-laic'); process.exit(2); }
  if (!frameJson && a['frame-json']) frameJson = JSON.parse(fs.readFileSync(a['frame-json'], 'utf8'));

  const records = scanDir(renderDir);
  if (!records.length) { console.error('未在 ' + renderDir + ' 找到符合 laic 命名的 PNG'); process.exit(3); }
  const pack = buildPack(records, crf60Index(frameJson), {
    id: a.id || 'laic.' + path.basename(renderDir),
    prefix: a.prefix || '',
    defaultTicks: Number(a['default-ticks'] || 4),
  });
  const out = a.out || renderDir;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(pack, null, 2));
  const clips = Object.keys(pack.animations).length;
  const dirs = Object.values(pack.animations).reduce((n, c) => n + Object.keys(c.directions).length, 0);
  console.log('pack.json -> ' + path.join(out, 'pack.json'));
  console.log('  canvas ' + pack.canvas.width + 'x' + pack.canvas.height + ', clips ' + clips + ', directions ' + dirs + ', frames ' + records.length);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
