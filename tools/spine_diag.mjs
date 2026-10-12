// 诊断：一个 Spine 模型里到底有什么，我的导出漏了哪些槽位
import { loadSpineRuntime, loadModel } from './spine_export.mjs';

const dir = process.argv[2];
const base = process.argv[3];
const spine = loadSpineRuntime();
const { data, skeleton } = await loadModel(spine, dir, base);

console.log('skeleton version :', data.version, '| hash', data.hash);
console.log('尺寸            :', data.width, 'x', data.height);
console.log('skins           :', (data.skins || []).map((s) => s.name).join(', '));
console.log('默认 skin       :', skeleton.skin ? skeleton.skin.name : '(none)');
console.log('动画            :', (data.animations || []).map((a) => a.name).join(', '));
console.log('槽位总数        :', (data.slots || []).length);
console.log('skin 对象       :', JSON.stringify((data.skins || []).map(function (s) {
  var n = 0;
  try {
    if (s.attachments) { for (var i = 0; i < s.attachments.length; i++) { var m = s.attachments[i]; if (m) { for (var k in m) n++; } } }
  } catch (e) { n = -1; }
  return s.name + ' attachments=' + n;
})));
console.log('skin.name 类型  :', data.skins && data.skins.length ? typeof data.skins[0].name : 'n/a');

function filled() {
  const out = [];
  for (let i = 0; i < data.slots.length; i++) {
    const slot = data.slots[i];
    let att = null;
    try { att = skeleton.getAttachment(i, slot.attachmentName); } catch (e) { att = null; }
    if (!att && slot.attachmentName) { try { att = skeleton.getAttachment(i, slot.attachmentName); } catch (e) {} }
    out.push({ i, slot: slot.name, bone: slot.boneData ? slot.boneData.name : '?', att: att ? (att.name || att.constructor.name) : null });
  }
  return out;
}

skeleton.setToSetupPose();
skeleton.setSlotsToSetupPose();
let f = filled();
console.log('\n--- setup pose 下无附件的槽位 ---');
console.log(f.filter((x) => !x.att).map((x) => x.slot).join(', ') || '(无)');

const anim = (data.animations || []).find((a) => /relax/i.test(a.name)) || (data.animations || [])[0];
if (anim) {
  const sd = new spine.AnimationStateData(data);
  sd.defaultMix = 0;
  const st = new spine.AnimationState(sd);
  skeleton.setToSetupPose();
  st.setAnimation(0, anim.name, true);
  st.apply(skeleton);
  skeleton.updateWorldTransform();
  f = filled();
  const empty = f.filter((x) => !x.att);
  console.log('\n--- 动画 "' + anim.name + '" 第 0 帧下无附件的槽位 (' + empty.length + '/' + f.length + ') ---');
  console.log(empty.map((x) => x.slot).join(', ') || '(无)');
}

// 各 skin 能补上多少槽位
console.log('\n--- 每个 skin 的附件覆盖率 ---');
for (const sk of (data.skins || [])) {
  skeleton.setSkin(sk.name);
  skeleton.setToSetupPose();
  skeleton.setSlotsToSetupPose();
  const g = filled();
  console.log('  ' + sk.name + ': ' + g.filter((x) => x.att).length + '/' + g.length);
}
