#!/usr/bin/env bash
# cute-pet · Android 壳构建（纯 Android SDK 工具链，不用 Gradle）
#
# 与 build.ps1 是同一套流程的 bash 版 —— CI 跑 Linux，本机是 Windows：
#   build.ps1 -> Windows 本机手工调（现已不推荐，改走 CI）
#   build.sh  -> GitHub Actions（唯一正规出包路径）
#
# 依赖: aapt2 / javac / d8 / zipalign / apksigner / keytool / jar / unzip
#
#   bash build.sh [--sdk /path/to/sdk] [--build-tools 36.0.0] [--platform android-36]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
BUILD_TOOLS="36.0.0"
PLATFORM="android-36"
while [ $# -gt 0 ]; do
  case "$1" in
    --sdk) SDK="$2"; shift 2;;
    --build-tools) BUILD_TOOLS="$2"; shift 2;;
    --platform) PLATFORM="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 2;;
  esac
done

[ -n "$SDK" ] || { echo "::error::未指定 SDK（--sdk 或 ANDROID_SDK_ROOT）"; exit 2; }
BT="$SDK/build-tools/$BUILD_TOOLS"
JAR="$SDK/platforms/$PLATFORM/android.jar"
OUT="$HERE/bin"
WORK="$HERE/build"

echo "SDK=$SDK  BT=$BT  PLATFORM=$PLATFORM"
# 关键：Android SDK 的工具不在 PATH 里，必须自己加进去。
# 少了这一句就是 "aapt2: command not found" + exit 127（已实测踩到）。
export PATH="$BT:$BT/lib:$PATH"
for t in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BT/$t" ] && [ ! -f "$BT/$t" ] && [ ! -f "$BT/$t.bat" ]; then
    echo "::error::缺工具: $BT/$t"; exit 2
  fi
done
[ -f "$JAR" ] || { echo "::error::缺 android.jar: $JAR"; exit 2; }
# d8 是个 wrapper 脚本，内部还会找 java；确认工具真的能跑起来
"$BT/aapt2" version 2>&1 | head -1 | sed 's/^/  /' || true

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/classes" "$WORK/dex" "$OUT"

# ── 1. 组装 Web 内容层（与 Electron 完全同一份）──
# 只带自绘 chibi + 索引；第三方版权素材由运行时按需下载（与 Windows 发布包一致）。
WEB="$WORK/assets/web"
mkdir -p "$WEB/vendor/pixi.js/dist" "$WEB/assets/packs"
cp -R "$ROOT/src" "$WEB/src"
cp "$ROOT/assets/packs-index.json" "$WEB/assets/packs-index.json"
cp -R "$ROOT/assets/packs/chibi" "$WEB/assets/packs/chibi"
cp "$ROOT/node_modules/pixi.js/dist/pixi.mjs" "$WEB/vendor/pixi.js/dist/pixi.mjs"
echo "内容层: $(find "$WEB" -type f | wc -l) 个文件"

# ── 2. aapt2 链接 ──
# 刻意不用 aapt2 的 -A 打包 assets：Windows 上它会把条目名写成反斜杠
# （assets\web\src\index.html），而 Android AssetManager 只认正斜杠，
# 结果 assets.open("web/src/index.html") 永远 404。改由第 5 步用 jar 追加（jar 会规范化成 /）。
aapt2 link -o "$WORK/base.apk" -I "$JAR" --manifest "$HERE/AndroidManifest.xml" \
  --java "$WORK/gen" --min-sdk-version 26 --target-sdk-version 36 --auto-add-overlay

# ── 3. javac ──
# -encoding UTF-8：中文 Windows 上 javac 默认 GBK，UTF-8 源码会炸出 47 个错。
mapfile -t SRCS < <(find "$HERE/src" "$WORK/gen" -name '*.java')
javac -encoding UTF-8 -classpath "$JAR" -d "$WORK/classes" "${SRCS[@]}"

# ── 4. d8 ──
mapfile -t CLASSES < <(find "$WORK/classes" -name '*.class')
d8 --lib "$JAR" --min-api 26 --output "$WORK/dex" "${CLASSES[@]}"

# ── 5. classes.dex 与 assets 塞进 APK ──
cp "$WORK/base.apk" "$WORK/unsigned.apk"
(cd "$WORK/dex" && jar uf "$WORK/unsigned.apk" classes.dex)
(cd "$WORK" && jar uf "$WORK/unsigned.apk" assets)

zipalign -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

# ── 6. 签名 ──
# CI 上用仓库里的 debug.keystore（固定签名 ⇒ 用户覆盖安装无需卸载重装）；
# 生产签名走 GitHub Secret，见 android-shell.yml 的注释。
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=cute-pet debug" \
    -keyalg RSA -keysize 2048 -validity 10000
fi
APK="$OUT/cute-pet-shell.apk"
apksigner sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$APK" "$WORK/aligned.apk"
apksigner verify --print-certs "$APK" | head -2

echo "产物: $APK  $(du -h "$APK" | cut -f1)"
