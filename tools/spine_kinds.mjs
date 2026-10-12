// 统计模型里的附件类型 / 混合模式 / clipping —— 判断 spine-canvas 这类简单渲染器会不会画不全
import { loadSpineRuntime, loadModel } from './spine_export.mjs';
const spine = loadSpineRuntime();
const { data } = await loadModel(spine, process.argv[2], process.argv[3]);

const kinds = {};
const blends = {};
let clipping = 0;
for (const skin of data.skins || []) {
  for (const entry of (typeof skin.getAttachments === 'function' ? skin.getAttachments() : [])) {
    const a = entry && entry.attachment;
    if (!a) continue;
    const t = a.constructor && a.constructor.name ? a.constructor.name : 'Unknown';
    kinds[t] = (kinds[t] || 0) + 1;
    if (t === 'ClippingAttachment' || a.type === 6) clipping++;
  }
}
for (const s of data.slots || []) {
  const b = s.blendMode === undefined ? 'normal' : String(s.blendMode);
  blends[b] = (blends[b] || 0) + 1;
}
console.log('skin 数        :', (data.skins || []).length);
console.log('附件类型分布   :', JSON.stringify(kinds));
console.log('clipping 附件  :', clipping);
console.log('slot 混合模式  :', JSON.stringify(blends));
console.log('bone 数        :', (data.bones || []).length);
console.log('ik/transform   :', (data.ikConstraints || []).length + '/' + (data.transformConstraints || []).length);
console.log('events         :', (data.events || []).map((e) => e.name).join(','));
