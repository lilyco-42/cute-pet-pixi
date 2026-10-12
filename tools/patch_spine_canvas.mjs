#!/usr/bin/env node
// 给 vendored 的 spine-canvas 3.8 打「混合模式」补丁（可重复执行，幂等）。
//
// 问题：drawTriangles 里读到了 slot.data.blendMode 并赋给局部 blendMode，然后就没了 ——
//       从头到尾没碰 ctx.globalCompositeOperation（全文件出现 0 次）。
//       于是 Additive(1)/Multiply(2)/Screen(3) 的槽位全部按 Normal 画。
//       明日方舟「动态立绘」实测有 20 个 Additive 槽位（发光/特效层），全都会失真。
//
// 修法：per-slot 设置 canvas 2D 的混合模式，并在 drawTriangles 收尾复位。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const V = path.resolve(path.dirname(process.argv[1]), '..', 'vendor', 'spine-3.8', 'spine-canvas.js');

export function patch(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('globalCompositeOperation')) return { changed: false, reason: 'already-patched' };
  const anchor = 'blendMode = slotBlendMode;';
  const at = src.indexOf(anchor);
  if (at < 0) return { changed: false, reason: 'anchor-not-found' };
  const op = '\n\t\t\t\t\t\t\tthis.ctx.globalCompositeOperation = ' +
    'blendMode == 1 ? "lighter" : blendMode == 2 ? "multiply" : blendMode == 3 ? "screen" : "source-over";';
  let out = src.slice(0, at + anchor.length) + op + src.slice(at + anchor.length);
  // 收尾复位：找 drawTriangles 循环之后的那次 globalAlpha = 1
  const tailAnchor = 'this.ctx.globalAlpha = 1;';
  const ti = out.indexOf(tailAnchor, out.indexOf(anchor));
  if (ti < 0) return { changed: false, reason: 'tail-anchor-not-found' };
  out = out.slice(0, ti + tailAnchor.length) +
    '\n\t\t\t\tthis.ctx.globalCompositeOperation = "source-over";' +
    out.slice(ti + tailAnchor.length);
  fs.writeFileSync(file, out);
  return { changed: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = patch(V);
  console.log('spine-canvas 补丁: ' + JSON.stringify(r));
  const after = fs.readFileSync(V, 'utf8');
  console.log('  globalCompositeOperation 出现次数: ' + (after.match(/globalCompositeOperation/g) || []).length);
}
