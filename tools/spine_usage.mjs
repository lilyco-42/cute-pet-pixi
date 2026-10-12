// 逐帧统计：每个槽位实际挂的是什么附件类型；mesh 到底有没有被动画用到
import { loadSpineRuntime, loadModel } from './spine_export.mjs';
const spine = loadSpineRuntime();
const { data, skeleton } = await loadModel(spine, process.argv[2], process.argv[3]);
const fps = 10;

const meshUse = new Map();     // slotName -> 帧次数
const kindBySlot = new Map();
for (const anim of data.animations) {
  const sd = new spine.AnimationStateData(data);
  sd.defaultMix = 0;
  for (let f = 0; f < Math.max(1, Math.round(anim.duration * fps)); f++) {
    skeleton.setToSetupPose();
    const st = new spine.AnimationState(sd);
    st.setAnimation(0, anim.name, true);
    for (let k = 0; k <= f; k++) { st.update(1 / fps); st.apply(skeleton); }
    skeleton.updateWorldTransform();
    for (const slot of skeleton.slots) {
      const a = slot.getAttachment();
      const t = a ? (a.constructor && a.constructor.name || '?') : 'none';
      kindBySlot.set(slot.data.name, t);
      if (t === 'MeshAttachment') meshUse.set(slot.data.name, (meshUse.get(slot.data.name) || 0) + 1);
    }
  }
}
console.log('槽位实际附件类型（任意帧看到的）:');
const byKind = {};
for (const [, t] of kindBySlot) byKind[t] = (byKind[t] || 0) + 1;
console.log('  ' + JSON.stringify(byKind));
console.log('\n动画里真的出现过 MeshAttachment 的槽位: ' + (meshUse.size ? [...meshUse.entries()].map(([k, v]) => k + '(' + v + '帧)').join(', ') : '(无)'));
