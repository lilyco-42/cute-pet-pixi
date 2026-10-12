#!/usr/bin/env node
// 验证自写 PNG 的产物：能反解、尺寸正确、内容非空。
//
// 为什么要单独验：tools/spine_export.mjs 现在绕开 cairo 的编码器自己封 PNG。
// 自己写的东西必须被独立验证 —— 否则可能产出「能生成但读不了」的文件，
// 而这种问题一路到运行时才会暴露（画面空白）。
//
//   node tools/verify_png.mjs <目录> [期望宽度] [期望高度]
import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage } from 'canvas';

const dir = process.argv[2];
const wantW = process.argv[3] ? Number(process.argv[3]) : null;
const wantH = process.argv[4] ? Number(process.argv[4]) : null;
if (!dir || !fs.existsSync(dir)) { console.error('用法: verify_png.mjs <目录> [w] [h]'); process.exit(2); }

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
if (!files.length) { console.error('目录里没有 PNG: ' + dir); process.exit(1); }
console.log('检查 ' + files.length + ' 个 PNG');

let bad = 0, empty = 0, w = null, h = null;
for (const f of files) {
  const p = path.join(dir, f);
  let img;
  try { img = await loadImage(fs.readFileSync(p)); }
  catch (e) { console.error('  ❌ ' + f + ' 解不开: ' + e.message); bad++; continue; }
  w = img.width; h = img.height;
  if (wantW && img.width !== wantW) { console.error('  ❌ ' + f + ' 宽度 ' + img.width + ' != ' + wantW); bad++; continue; }
  if (wantH && img.height !== wantH) { console.error('  ❌ ' + f + ' 高度 ' + img.height + ' != ' + wantH); bad++; continue; }
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, img.width, img.height).data;
  let nz = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 16) nz++;
  if (nz === 0) { console.error('  ❌ ' + f + ' 全透明（应该是空帧）'); empty++; }
}

console.log('尺寸: ' + w + 'x' + h);
console.log('解不开: ' + bad + '   空帧: ' + empty);
if (bad || empty) { console.error('PNG 自检失败'); process.exit(1); }
console.log('PNG 自检通过');