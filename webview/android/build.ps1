# cute-pet · Android 壳构建（纯 Android SDK 工具链，不用 Gradle）
# 依赖: aapt2 / javac / d8 / zipalign / apksigner / keytool
param(
  [string]$Sdk = $env:ANDROID_SDK_ROOT,
  [string]$BuildTools = "36.0.0",
  [string]$Platform = "android-36"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here "..\..")
$bt = Join-Path $Sdk ("build-tools\" + $BuildTools)
$jar = Join-Path $Sdk ("platforms\" + $Platform + "\android.jar")
$out = Join-Path $here "bin"
$work = Join-Path $here "build"

Write-Host "SDK=$Sdk  BT=$bt"
foreach ($t in @("aapt2.exe","d8.bat","zipalign.exe","apksigner.bat")) {
  if (-not (Test-Path (Join-Path $bt $t))) { throw ("缺工具: " + (Join-Path $bt $t)) }
}
if (-not (Test-Path $jar)) { throw ("缺 android.jar: " + $jar) }

Remove-Item -Recurse -Force $work, $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$work\classes","$work\dex","$out" | Out-Null

# ---- 1. 组装 Web 内容层（与 Electron 完全同一份）----
$web = Join-Path $work "assets\web"
New-Item -ItemType Directory -Force -Path "$web\vendor\pixi.js\dist" | Out-Null
Copy-Item -Recurse (Join-Path $root "src") (Join-Path $web "src")
# 只带自绘 chibi + 索引；第三方版权素材由运行时按需下载（与 Windows 发布包一致）
New-Item -ItemType Directory -Force -Path "$web\assets\packs" | Out-Null
Copy-Item (Join-Path $root "assets\packs-index.json") (Join-Path $web "assets\packs-index.json")
Copy-Item -Recurse (Join-Path $root "assets\packs\chibi") (Join-Path $web "assets\packs\chibi")
Copy-Item (Join-Path $root "node_modules\pixi.js\dist\pixi.mjs") (Join-Path $web "vendor\pixi.js\dist\pixi.mjs")
Write-Host ("内容层: " + (Get-ChildItem -Recurse -File $web | Measure-Object).Count + " 个文件")

# ---- 2. aapt2 链接 ----
# 刻意不用 aapt2 的 -A 打包 assets：Windows 上 aapt2 会把条目名写成反斜杠
# （assets\web\src\index.html），而 Android AssetManager 只认正斜杠，
# 结果 assets.open("web/src/index.html") 永远 404。改由第 5 步用 jar 追加（jar 会规范化成 /）。
& "$bt\aapt2.exe" link -o "$work\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" --java "$work\gen" --min-sdk-version 26 --target-sdk-version 36 --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

# ---- 3. javac ----
$srcs = @(Get-ChildItem -Recurse -File -Filter *.java "$here\src", "$work\gen" | ForEach-Object { $_.FullName })
& javac -encoding UTF-8 -classpath $jar -d "$work\classes" @srcs
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

# ---- 4. d8 ----
$classes = @(Get-ChildItem -Recurse -File "$work\classes" -Filter *.class | ForEach-Object { $_.FullName })
& "$bt\d8.bat" --lib $jar --min-api 26 --output "$work\dex" @classes
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

# ---- 5. classes.dex 塞进 APK ----
Copy-Item "$work\base.apk" "$work\unsigned.apk"
& jar uf "$work\unsigned.apk" -C "$work\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar uf classes.dex 失败" }
& jar uf "$work\unsigned.apk" -C "$work" assets
if ($LASTEXITCODE -ne 0) { throw "jar uf web 失败" }

& "$bt\zipalign.exe" -f 4 "$work\unsigned.apk" "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

# ---- 6. 签名 ----
$ks = Join-Path $here "debug.keystore"
if (-not (Test-Path $ks)) {
  & keytool -genkeypair -keystore $ks -storepass android -keypass android -alias androiddebugkey -dname "CN=cute-pet debug" -keyalg RSA -keysize 2048 -validity 10000
  if ($LASTEXITCODE -ne 0) { throw "keytool 失败" }
}
$apk = Join-Path $out "cute-pet-shell.apk"
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --out $apk "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }
& "$bt\apksigner.bat" verify --print-certs $apk | Select-Object -First 2

Write-Host ("产物: " + $apk + "  " + [math]::Round((Get-Item $apk).Length / 1MB, 2) + " MB")
