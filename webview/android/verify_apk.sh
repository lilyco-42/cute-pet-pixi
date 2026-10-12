#!/usr/bin/env bash
# cute-pet Android 壳产物校验 —— CI 与本机同一套断言。
#
# 为什么要有这个脚本：以前校验是 workflow 里的 inline grep，改一处漏一处，
# 和本地手工核验漂移。固化之后 CI 卡的就是本机卡的那一套。
#
#   bash webview/android/verify_apk.sh <apk> [--selftest]
#
# --selftest：先证明脚本「会失败」——抠掉一个必需项后必须 exit 1。
#   一个永远返回 0 的校验脚本比没有校验更糟，因为它给的是假安心。
set -uo pipefail

APK="${1:?用法: verify_apk.sh <apk> [--selftest]}"
SELFTEST="${2:-}"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ✅ $1"; }
bad()  { fail=$((fail+1)); echo "  ❌ $1"; }
need() { # need <文件> <关键字> <说明>
  if unzip -p "$APK" "$1" 2>/dev/null | strings | grep -qF "$2"; then ok "$3"; else bad "$3（$1 里找不到 $2）"; fi
}
has() { # has <apk 内路径> <说明>
  if unzip -Z1 "$APK" 2>/dev/null | grep -qxF "$1"; then ok "$2"; else bad "$2（缺 $1）"; fi
}

echo "== 校验 $APK ($(du -h "$APK" | cut -f1)) =="
[ -f "$APK" ] || { echo "❌ 文件不存在"; exit 1; }

# ── 1. 结构：dex + 内容层 + manifest ──
has "classes.dex"                    "classes.dex 存在"
has "assets/web/src/index.html"      "Web 内容层入口存在"
has "assets/web/assets/packs-index.json" "素材索引存在（按需下载要用）"
has "assets/web/assets/packs/chibi/pack.json" "内置 chibi 素材包存在"
has "assets/web/vendor/pixi.js/dist/pixi.mjs" "pixi.js 已打包进内容层"
has "AndroidManifest.xml"            "AndroidManifest.xml 存在"

# ── 2. 合规闸门：第三方版权角色素材不得编入 APK ──
# 只允许内置自绘 chibi。arknights-* / nctype-* / yuzusoft-* 必须走运行时下载。
leaked=$(unzip -Z1 "$APK" 2>/dev/null | grep -E '^assets/web/assets/packs/(arknights-|nctype-|yuzusoft-|aic-)' | head -5)
if [ -z "$leaked" ]; then ok "合规：APK 内无第三方版权角色素材"
else bad "合规：APK 内混入第三方素材 -> $(echo "$leaked" | tr '\n' ' ')"; fi

# ── 3. 依赖：壳必须零第三方（不用 Gradle / androidx）──
if unzip -Z1 "$APK" 2>/dev/null | grep -qE '^(lib/|classes[0-9]+\.dex)'; then
  bad "出现了 native 库或额外 dex —— 本壳刻意保持纯 framework"
else ok "纯 framework：单一 dex、无 native 库"; fi

# ── 4. 代码：关键类与接线必须在 dex 里 ──
for s in "rust/cute_pet/OverlayService" "rust/cute_pet/MainActivity" "rust/cute_pet/PackFetcher" \
         "PetBridge" "pickPack" "reloadPack" "shouldInterceptRequest"; do
  if unzip -p "$APK" classes.dex | strings | grep -qF "$s"; then ok "dex 含 $s"; else bad "dex 缺 $s"; fi
done

# ── 5. 权限：没有 INTERNET 时全部 13 个包会静默失败（实测踩过）──
if unzip -p "$APK" AndroidManifest.xml | strings | grep -q "INTERNET"; then
  ok "已声明 INTERNET 权限"
else bad "缺 INTERNET 权限 —— 素材下载会 SecurityException"; fi

# ── 6. 体积：超过 5 MB 说明素材被误编进去了 ──
size=$(stat -c%s "$APK" 2>/dev/null || stat -f%z "$APK")
if [ "$size" -lt 5242880 ]; then ok "体积 $((size/1024)) KB（无素材，符合预期）"
else bad "体积 ${size} 字节偏大，疑似编入了素材"; fi

echo "== 通过 $pass / 失败 $fail =="

# ── 反向自检：证明这套断言真的会拦下东西 ──
if [ "$SELFTEST" = "--selftest" ]; then
  echo "== 反向自检：抠掉 classes.dex 后必须失败 =="
  tmp=$(mktemp -d); cp "$APK" "$tmp/t.apk"
  (cd "$tmp" && zip -q -d t.apk classes.dex >/dev/null 2>&1)
  if bash "$0" "$tmp/t.apk" >/dev/null 2>&1; then
    echo "  ❌ 自检失败：抠掉 classes.dex 后仍然通过"; rm -rf "$tmp"; exit 1
  else
    echo "  ✅ 自检通过：缺失项确实会被拦下"; rm -rf "$tmp"
  fi
fi

[ "$fail" -eq 0 ] || exit 1
