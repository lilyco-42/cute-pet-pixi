#!/usr/bin/env bash
# 素材包结构校验 —— 与运行时 src/assets/pack.js 的 normalizePack() 同一套约定。
#
# 为什么需要它：pack.json 里少一个字段，运行时是「静默降级」而不是报错：
#   · 漏 behaviors  -> 桌宠只会站着不动（曾经真的这样，排查了很久）
#   · 漏 animations -> 白屏
#   · frames 路径错 -> 请求 404，画面空白但控制台安静
# CI 上先把这些静态抓出来。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
INDEX="$ROOT/assets/packs-index.json"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ✅ $1"; }
bad() { fail=$((fail+1)); echo "  ❌ $1"; }

echo "== 校验素材索引 $INDEX =="
[ -f "$INDEX" ] || { echo "❌ 索引不存在"; exit 1; }

# ── 1. 索引自身结构 ──
node - "$INDEX" <<'EOF'
const fs = require('fs');
const idx = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const errs = [];
// 兼容两种写法：pack.json 用 schema，索引历史上用 version（运行时读的是 version）。
const ver = idx.schema !== undefined ? idx.schema : idx.version;
if (ver !== 1) errs.push('schema/version 应为 1，实际 ' + ver);
if (!Array.isArray(idx.packs)) errs.push('packs 应为数组');
const seen = new Set();
for (const p of idx.packs || []) {
  for (const k of ['id', 'file', 'url', 'bytes', 'sha256']) {
    if (!p[k]) errs.push((p.id || '?') + ' 缺字段 ' + k);
  }
  if (seen.has(p.id)) errs.push('重复 id: ' + p.id);
  seen.add(p.id);
  if (p.sha256 && !/^[0-9a-f]{64}$/i.test(p.sha256)) errs.push(p.id + ' 的 sha256 不是 64 位十六进制');
  if (p.bytes && (typeof p.bytes !== 'number' || p.bytes <= 0)) errs.push(p.id + ' 的 bytes 非法');
  // 命名约定：<prefix>-<slug>-<ver>.tar.gz，prefix 用来分辨素材来源
  if (p.file && !/^(arknights|yuzusoft|nctype|aic|original)-.+-\d+\.\d+\.\d+\.tar\.gz$/.test(p.file)) {
    errs.push(p.id + ' 的文件名不符合 <prefix>-<slug>-<ver>.tar.gz：' + p.file);
  }
}
if (errs.length) { console.error('  ❌ ' + errs.join('\n  ❌ ')); process.exit(1); }
console.log('  ✅ 索引结构正确（' + idx.packs.length + ' 个包）');
const by = {}; for (const p of idx.packs) by[p.kind] = (by[p.kind]||0)+1;
console.log('     kind: ' + JSON.stringify(by));
EOF
if [ $? -eq 0 ]; then ok "索引结构"; else bad "索引结构"; fi

# ── 2. 内置 chibi 的 pack.json 必须完整 ──
echo "== 校验内置 chibi 素材包 =="
node - "$ROOT/assets/packs/chibi/pack.json" <<'EOF'
const fs = require('fs'), path = require('path');
const f = process.argv[2];
if (!fs.existsSync(f)) { console.error('  ❌ 缺 ' + f); process.exit(1); }
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
const errs = [];
if (p.schema !== 1) errs.push('schema 应为 1');
if (!p.id) errs.push('缺 id');
if (!p.canvas || !p.canvas.width || !p.canvas.height) errs.push('缺 canvas');
if (!p.animations || !Object.keys(p.animations).length) errs.push('缺 animations');
// behaviors 是「桌宠会不会自己动」的开关；漏了就是站着不动且不报错。
if (!p.behaviors) errs.push('缺 behaviors —— 桌宠会静止不动（运行时静默降级）');
else if (!p.behaviors.states || !Object.keys(p.behaviors.states).length) errs.push('behaviors.states 为空');
else {
  // 更深一层：behaviors 里引用的 clip 必须真实存在，否则运行时切到该状态会崩。
  const clips = new Set(Object.keys(p.animations || {}));
  for (const [sn, sd] of Object.entries(p.behaviors.states)) {
    if (!p.behaviors.states[p.behaviors.initial]) errs.push('initial=' + p.behaviors.initial + ' 不是 states 里的键');
    for (const ph of sd.phases || []) {
      if (ph.clip && !clips.has(ph.clip)) errs.push('状态 ' + sn + ' 引用了不存在的 clip "' + ph.clip + '"，可用: ' + [...clips].join(','));
    }
    if (sd.after && sd.after !== 'idle' && sd.after !== 'choose' && !p.behaviors.states[sd.after]) {
      errs.push('状态 ' + sn + ' 的 after="' + sd.after + '" 不存在');
    }
  }
  // 权重表里的状态也必须存在
  for (const k of Object.keys(p.behaviors.choose?.weights || {})) {
    if (!p.behaviors.states[k]) errs.push('choose.weights 引用了不存在的状态 ' + k);
  }
}
// 每个帧文件的 src 必须真实存在
const dir = path.dirname(f);
let n = 0;
for (const [an, a] of Object.entries(p.animations || {})) {
  for (const [dn, d] of Object.entries(a.directions || {})) {
    for (const fr of d.frames || []) {
      for (const l of fr.layers || []) {
        n++;
        if (!fs.existsSync(path.join(dir, l.src))) { errs.push(an + '/' + dn + ' 缺帧文件 ' + l.src); }
        if (errs.length > 8) break;
      }
      if (errs.length > 8) break;
    }
  }
}
if (errs.length) { console.error('  ❌ ' + errs.slice(0,8).join('\n  ❌ ')); process.exit(1); }
console.log('  ✅ chibi 完整（' + Object.keys(p.animations).length + ' 段动画 / ' + n + ' 个帧引用 / behaviors=' + Object.keys(p.behaviors.states).length + ' 态）');
EOF
if [ $? -eq 0 ]; then ok "chibi 包完整"; else bad "chibi 包"; fi

# ── 3. 合规：仓库里不得出现第三方版权角色素材 ──
echo "== 合规闸门 =="
# 只认「被 git 跟踪」的文件：本地开发时 assets/packs/ 下会躺着大量烘焙好的
# 第三方素材（被 .gitignore 挡着），那不是违规；CI 检出的是干净工作树。
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  leaked=$(git -C "$ROOT" ls-files "assets/packs/*" | grep -v "^assets/packs/chibi/" | head -10)
  ctx="git 跟踪的文件"
else
  leaked=$(find "$ROOT/assets/packs" -mindepth 1 -maxdepth 1 -type d ! -name chibi 2>/dev/null | head -10)
  ctx="工作区目录（无 git）"
fi
if [ -z "$leaked" ]; then ok "仓库内只有自绘 chibi（第三方素材走 Release 下载，$ctx）"
else bad "仓库里混入了第三方素材（见上）"; fi
echo "== 通过 $pass / 失败 $fail =="
[ "$fail" -eq 0 ] || exit 1
