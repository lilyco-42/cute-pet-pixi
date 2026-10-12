#!/usr/bin/env node
// Ethornell(.chr 语义) 分层立绘 -> 统一资产包 pack.json
//
// 输入是 cute-pet 现有的 *_manifest.json（柚子社 Ethornell 角色定义的归一化形态）：
//   sets.<set>.stand            : 姿势元信息（本实现未用，原 Rust 里也是 dead_code）
//   sets.<set>.info.dress[]     : { dress, diff, layer }  —— 同 (dress,diff) 可有多行 = 多个图层
//   sets.<set>.info.face[]      : { face, layer }         —— layer 形如 "组名/层名"
//   sets.<set>.composition.groups: { 组名: group_id }
//   sets.<set>.composition.items : { "<key>": { name, left, top, w, h, opacity, layer_id, group } }
//   图层图片 = <layers>/<set>_<layer_id>.png，尺寸与 item.w/h 1:1，贴在 (left, top)
//
// 绘制顺序（照抄 pet/src/voice/mod.rs 的 z_index，但**改成确定性顺序**）：
//   z=2  name 含 "髪かぶせ"（头发盖层）
//   z=1  group ∈ {表情, 表情（追加）}
//   z=3  group != 0 且不属于上面（泪/腮红/气息）
//   z=0  其余（身体/服装）
// 原实现用 items.values()（Rust HashMap）遍历，同 z 内顺序每次运行都可能不同 —— 这里改用
// manifest 的键序，稳定可复现。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

export function zIndexOf(item, groups) {
  const g1 = groups['表情'];
  const g2 = groups['表情（追加）'];
  if (String(item.name).includes('髪かぶせ')) return 2;
  if (item.group === g1 || item.group === g2) return 1;
  if (item.group !== 0) return 3;
  return 0;
}

export function buildPack(manifest, setId, layersDir, opts = {}) {
  const set = manifest.sets[setId];
  if (!set) throw new Error('manifest 里没有 set ' + setId);
  const items = set.composition.items;              // 保持 JSON 键序 = 原始图层顺序
  const groups = set.composition.groups || {};
  const entries = Object.entries(items);            // [key, item]

  // 角色轮廓 -> 画布
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, it] of entries) {
    minX = Math.min(minX, it.left); minY = Math.min(minY, it.top);
    maxX = Math.max(maxX, it.left + it.w); maxY = Math.max(maxY, it.top + it.h);
  }
  const bboxW = maxX - minX, bboxH = maxY - minY;

  // 复制图层图片，按 layer_id 命名（与 Rust 的 "<set>_<layer_id>.png" 一致）
  const outLayers = path.join(opts.out, 'layers');
  fs.mkdirSync(outLayers, { recursive: true });
  const copied = new Set();
  for (const [, it] of entries) {
    const src = path.join(layersDir, setId + '_' + it.layer_id + '.png');
    const dst = path.join(outLayers, setId + '_' + it.layer_id + '.png');
    if (!fs.existsSync(src)) { console.warn('  缺图: ' + src); continue; }
    if (!copied.has(dst)) { fs.copyFileSync(src, dst); copied.add(dst); }
  }

  const layerOf = (it) => ({
    src: 'layers/' + setId + '_' + it.layer_id + '.png',
    x: it.left - minX,
    y: it.top - minY,
    w: it.w,
    h: it.h,
    z: zIndexOf(it, groups),
    alpha: Math.min(1, (it.opacity || 255) / 255),
  });

  // dress 变体：同 (dress,diff) 的多行 = 多个图层，按 items 键序取
  const dressMap = new Map();
  for (const d of set.info.dress) {
    const key = d.dress + '|' + d.diff;
    if (!dressMap.has(key)) dressMap.set(key, { id: key, label: d.dress, diff: d.diff, names: new Set() });
    dressMap.get(key).names.add(d.layer);
  }
  const dressOptions = [...dressMap.values()].map((o) => ({
    id: o.id, label: o.label, diff: o.diff,
    layers: entries.filter(([, it]) => o.names.has(it.name)).map(([, it]) => layerOf(it)),
  }));

  // face 变体：layer 形如 "组名/层名"
  const faceMap = new Map();
  for (const f of set.info.face) {
    if (!faceMap.has(f.face)) faceMap.set(f.face, []);
    faceMap.get(f.face).push(f.layer);
  }
  const faceOptions = [];
  for (const [face, layers] of faceMap) {
    const picked = [];
    for (const spec of layers) {
      const [groupName, layerName] = String(spec).split('/');
      if (layerName === undefined) {
        // 裸层名 = group 0 的层。原 Rust 实现直接 continue 跳过，导致 "01h".."40h" 这 40 个
        // 腮红变体全部渲染成与基础表情一模一样（实测 face 01h 与 01 逐像素无差异）——
        // 这里按 Ethornell 语义回退到 group 0 找同名层。
        for (const [, it] of entries) if (it.group === 0 && it.name === groupName) picked.push(layerOf(it));
        continue;
      }
      const gid = groups[groupName];
      if (gid === undefined) { console.warn('  face ' + face + ' 引用了不存在的组: ' + groupName); continue; }
      for (const [, it] of entries) if (it.group === gid && it.name === layerName) picked.push(layerOf(it));
    }
    faceOptions.push({ id: face, label: face, layers: picked });
  }

  const defDress = dressOptions.find((o) => o.label === (opts.defaultDress || '私服')) || dressOptions[0];
  const defFace = faceOptions.find((o) => o.id === (opts.defaultFace || '01')) || faceOptions[0];

  return {
    schema: 1,
    id: opts.id || ('ethornell.' + (manifest.voice_code || manifest.character || setId) + '.' + setId),
    format: 'variants',
    canvas: { width: bboxW, height: bboxH },
    scale: Number(opts.scale || (1 / 3)),
    anchor: { x: 0.5, y: 1.0 },
    hitThreshold: 90,
    idle: { bobAmplitude: 4, bobSpeed: 1.2 },   // 照抄原实现的 sin(t*1.2)*4
    source: {
      kind: 'ethornell',
      note: 'Ethornell(.chr) 分层立绘，由 tools/ethornell_import.mjs 归一化；' +
            '角色素材版权归原作者/发行商，不随本项目分发',
      character: manifest.character,
      nameCn: manifest.name_cn,
      setId,
    },
    variants: {
      dress: { default: defDress.id, options: dressOptions },
      face: { default: defFace.id, options: faceOptions },
    },
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.manifest || !a.layers || !a.out) {
    console.error('用法: node tools/ethornell_import.mjs --manifest <m.json> --layers <dir> --out <packdir> [--set a] [--scale 0.3333]');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(a.manifest, 'utf8'));
  const setId = a.set || 'a';
  const pack = buildPack(manifest, setId, a.layers, {
    out: a.out, scale: a.scale, id: a.id,
    defaultDress: a['default-dress'], defaultFace: a['default-face'],
  });
  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, 'pack.json'), JSON.stringify(pack, null, 2));
  const d = pack.variants.dress.options, f = pack.variants.face.options;
  console.log('pack.json -> ' + path.join(a.out, 'pack.json'));
  console.log('  canvas ' + pack.canvas.width + 'x' + pack.canvas.height + ' @scale ' + pack.scale +
    ' -> 窗口 ' + Math.round(pack.canvas.width * pack.scale) + 'x' + Math.round(pack.canvas.height * pack.scale));
  console.log('  dress ' + d.length + ' 项 (默认 ' + pack.variants.dress.default + ', 图层数 ' + d.map(x => x.layers.length).join('/') + ')');
  console.log('  face  ' + f.length + ' 项 (默认 ' + pack.variants.face.default + ')');
  console.log('  复制图层 ' + fs.readdirSync(path.join(a.out, 'layers')).length + ' 张');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
