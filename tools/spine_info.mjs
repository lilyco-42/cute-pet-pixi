// 列出模型动画时长，并与导出器的帧上限对照
import { loadSpineRuntime, loadModel } from './spine_export.mjs';

const dir = process.argv[2];
const base = process.argv[3];
const fps = Number(process.argv[4] || 10);
const cap = Number(process.argv[5] || 60);

const spine = loadSpineRuntime();
const { data } = await loadModel(spine, dir, base);
const anims = [...data.animations].sort((a, b) => b.duration - a.duration);
console.log('动画 ' + anims.length + ' 个 | fps=' + fps + ' | 帧上限=' + cap);
console.log('名称'.padEnd(12) + '时长(s)'.padStart(9) + '需要帧'.padStart(8) + '实际导出'.padStart(10) + '  (上限 0 = 不截断)');
for (const a of anims) {
  const need = Math.max(1, Math.round(a.duration * fps));
  const got = cap > 0 ? Math.min(cap, need) : need;
  console.log(a.name.padEnd(12) + a.duration.toFixed(2).padStart(9) + String(need).padStart(8) + String(got).padStart(10) + (got < need ? '  <-- 被截断 ' + (need - got) + ' 帧' : ''));
}
console.log('\n全部导出需要的总帧数: ' + anims.reduce((n, a) => n + Math.max(1, Math.round(a.duration * fps)), 0));
