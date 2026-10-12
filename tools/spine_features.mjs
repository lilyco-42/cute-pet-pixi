#!/usr/bin/env node
// 检测模型用了哪些 canvas 路径不支持的特性，决定是否需要切 WebGL 渲染器。
//
// 为什么需要这个：spine-canvas 只解析 ClippingAttachment，**没有 stencil 实现**
// （实测 spine-canvas.js 里 'stencil' 出现 0 次），所以遮罩被静默忽略。
// 但只有真的用了 clipping 的模型才需要 GPU 路径 —— 先量一下有多少。
//
//   node tools/spine_features.mjs [--models <dir>]

import fs from 'node:fs';
import path from 'node:path';

// 用官方运行时正确解析二进制（不靠猜 varint），只读元数据、不渲染。
import { loadSpineRuntime, loadModel } from './spine_export.mjs';

const root = process.argv.includes('--models')
  ? process.argv[process.argv.indexOf('--models') + 1]
  : 'models';

const spine = loadSpineRuntime();
const dirs = fs.readdirSync(root).filter((d) => {
  const f = path.join(root, d);
  return fs.statSync(f).isDirectory() && fs.readdirSync(f).some((x) => x.endsWith('.atlas'));
});

// pixi-spine / spine 的 AttachmentType 枚举：Clipping = 6
const CLIPPING = 6;
let needGpu = 0;
const rows = [];

for (const d of dirs) {
  const dir = path.join(root, d);
  const base = fs.readdirSync(dir).find((f) => f.endsWith('.atlas')).replace(/\.atlas$/, '');
  let data, skeleton;
  try { ({ data, skeleton } = await loadModel(spine, dir, base)); }
  catch (e) { rows.push([d, '解析失败: ' + e.message, 0, 0, 0]); continue; }

  let clipping = 0, mesh = 0, region = 0, blendOther = 0;
  // 遍历每个 skin 的附件；用 getAttachments() 拿全量（含未挂到槽位上的）
  for (const skin of data.skins || []) {
    let list = [];
    try {
      list = typeof skin.getAttachments === 'function' ? skin.getAttachments() : [];
    } catch (e) { list = []; }
    for (const entry of list) {
      const att = entry && entry.attachment;
      if (!att) continue;
      const t = att.type;
      if (t === CLIPPING) clipping++;
      else if (t === 3 /* Mesh */) mesh++;
      else if (t === 0 /* Region */) region++;
    }
  }
  // blendMode: 0=Normal 之外的都算非普通混合
  for (const s of data.slots || []) if (s.blendMode) blendOther++;

  const gpu = clipping > 0;
  if (gpu) needGpu++;
  rows.push([d, gpu ? '需要 GPU' : 'canvas 够用', clipping, mesh, blendOther]);
}

console.log('模型'.padEnd(26) + '结论'.padEnd(12) + 'clipping'.padStart(9) + 'mesh'.padStart(8) + '非普通混合'.padStart(12));
for (const [n, v, c, m, b] of rows) {
  console.log(String(n).padEnd(26) + String(v).padEnd(12) + String(c).padStart(9) + String(m).padStart(8) + String(b).padStart(12));
}

console.log('');
console.log('合计 ' + rows.length + ' 个模型，其中 ' + needGpu + ' 个含 clipping（需要 WebGL 路径）');
console.log(needGpu === 0
  ? '结论：当前模型集全部可用 canvas 路径，WebGL 导出器暂无必须用途（保留备用）。'
  : '结论：有 ' + needGpu + ' 个模型需要 WebGL 路径，否则遮罩会被静默忽略。');