# cute-pet · Electron 渲染层

多素材兼容的跨平台桌宠。运行时不解析任何第三方格式——**所有素材源都由离线导入器归一化成统一资产包**，
运行时只画「分层精灵 + 帧序列」，时序单位统一为 **1/60s tick**。

## 运行

```bat
run.cmd            :: 或 npm start
run.cmd --dev      :: 带 DevTools
run.cmd --capture  :: 跑 2.5s 自截图到 docs/verify_render.png 后退出（CI 用）
```

操作：拖拽小人移动；点空白处事件穿透到桌面；ESC 退出。

## 为什么是 Electron + PixiJS

| 约束 | Electron 的答案 |
|---|---|
| 透明 / 无边框 / 置顶 | BrowserWindow 内置三个开关，三平台一致 |
| 逐像素点击穿透 | `mousemove` 命中 alpha 掩码 → `setIgnoreMouseEvents(true, {forward:true})` |
| 多素材兼容 | 唯一同时能拿到**官方 Spine 运行时**与**官方 Live2D Cubism Web SDK**的栈 |
| 渲染一致性 | 自带 Chromium，不受各平台 WebView 差异影响 |

## 结构

```
electron/main.js      透明置顶窗口 / 穿透切换 / 拖动 / pet:// 协议托管应用目录
electron/preload.js   contextBridge 暴露 window.pet
src/boot.js           Pixi 启动 + 输入（穿透、拖拽、ESC）+ 自截图
src/behavior.js       日常活动状态机（行为表在 pack.behaviors 里，运行时只做通用解释）
src/platform.js       宿主抽象：electron / webview(Android) / browser 三态降级
src/stage.js          统一模型播放器：frames 帧序列 + variants 可交互分层立绘
src/hitmask.js        逐层 alpha 缓存（不做整画布预合成）+ 命中测试
src/assets/pack.js    资产包加载 / 归一化
tools/laic_import.mjs      laic(PixelLiner) → 资产包
tools/desktopseyana_import.mjs  DesktopSeyana 精灵表/帧序列 → 资产包
tools/behaviors.mjs            行为表（抄自 DesktopSeyana）→ 写进 pack.behaviors
tools/make_icon.mjs            自绘 chibi → build/icon.ico
tools/ethornell_import.mjs Ethornell(.chr 语义) 分层立绘 → 资产包
tools/spine_export.mjs     Spine 3.8 → 资产包（离线烘焙，运行时零 Spine 依赖）
vendor/spine-3.8/          Spine 官方 3.8.95 运行时（仅离线导出器用）
webview/android/           Android 悬浮窗壳（纯 SDK 工具链出 APK，不用 Gradle）
tools/gen_placeholder.py   占位素材生成
docs/ASSET-SPEC.md    统一资产包规范 + 各素材源映射
fixtures/laic/        laic 命名契约的回归样例
```

## 日常活动（行为状态机）

规格**逐行抄自 nctype/DesktopSeyana**（`scripts/pet_window.gd` 的 `_build_*` / `_update_state_movement` +
`scripts/app.gd` 的 `choose_random_action`），但写成**声明式的 `behaviors` 块放进资产包**——
和素材源一样的思路：**换行为不动运行时**。

| 项 | Seyana 的事实（已 1:1 复刻） |
|---|---|
| 动作权重 | jumping 10 / **walking 25** / playing 10 / food_01 10 / food_02 5 / **chasing 15** / sleeping 15 / kabuto 10，且**排除上一个动作**（避免连续同一个） |
| 走路 | **58 px/s**（fast 档 ×1.25），方向 `Vector2(cos θ, sin θ × 0.35)` 归一化，**持续 5–12s**，撞屏幕边翻 x |
| 追光标 | **115 px/s** 朝光标，距离 ≤ **10px** 转 `surisuri` |
| idle | idle_start →（8% 走 idle_loop_02，否则 idle_loop_01 播 2/4/6/8 次）→ idle_end → **按权重选下一个动作** |
| 状态 | idle / jumping / walking / playing / food_01 / food_02 / chasing / surisuri / sleeping / kabuto |

`spine-min` 档把明日方舟干员的 6 段骨骼动画映射到同一套状态机（Relax=idle、Move=走路、Sit/Sleep/Interact…），
没有的动作就不进权重表——所以**同一套引擎既能驱动 Seyana 的几十个 clip，也能驱动一个 Spine 干员**。

实测（seyana 包，跑 24 秒）：

```
behavior: -> idle (start) [idle_start idle_loop_01 idle_end]
behavior: -> food_01 (random) [ebfly_start ebfly_01 ebfly_02 ebfly_end]
behavior: -> idle (sequence done) ...
behavior: -> walking (random) [walking_fast]
behavior: -> chasing (random) [chasing_start]
窗口轨迹 (1234,625) -> (1145,624) -> (710,624) -> (42,624)     ← 真的在桌面上走
```

## 发布

**素材包 Release 已发布**：<https://github.com/lilyco-42/cute-pet/releases/tag/packs-0.2.0>（13 个 tar.gz，78 MB）

### 代码签名（Windows）

当前 exe/msi **未签名**，`Get-AuthenticodeSignature` 返回 `NotSigned`，用户安装时 SmartScreen 会警告。
electron-builder 认这两个环境变量，拿到代码签名证书后设置即可，**不用改配置**：

```bat
set CSC_LINK=D:\cert\mycert.pfx
set CSC_KEY_PASSWORD=******
npm run dist
```

自签名证书**不能**消除 SmartScreen 警告（仍显示未知发布者），必须买 OV/EV 证书。

```bat
npm run dist            :: Windows：NSIS 安装包(.exe) + MSI
webview\android\build.ps1 -Sdk D:\android_sdk   :: Android：签名 APK
```

### 产物

| 平台 | 文件 | 大小 |
|---|---|---|
| Windows | `dist/cute-pet Setup 0.2.0.exe`（NSIS 安装包，可选安装目录） | ~93 MB |
| Windows | `dist/cute-pet 0.2.0.msi` | ~102 MB |
| Windows | `dist/win-unpacked/cute-pet.exe`（免安装目录版） | — |
| Android | `webview/android/bin/cute-pet-shell.apk`（debug 签名） | ~55 MB |

打包后的可执行文件已实测：`dist/win-unpacked/cute-pet.exe --capture` →
`ready[electron]: chibi.placeholder window=128x128`，截图落盘正常。
（打包最容易坏的就是 `pet://` 协议与素材路径，所以这一步必须真跑一遍。）

### 发布包里不放第三方版权素材

`npm run dist` 的 `files` 白名单**只带自绘的 chibi 包**，排除 `amiya`(鹰角) / `murasame`(柚子社) / `seyana`(nctype)。
做法与你自己仓库的 `--no-default-features` / `bundle-murasame` 一致：**默认合规**，不指望谁记得加开关。

### 热门角色素材包（第一批 12 个干员）

`tools/arknights_batch.mjs` 一条命令批量出包：**下载模型 → Spine 3.8 离线烘焙 → 注入 `spine-min` 行为表
→ 打带前缀的 tar.gz → 更新索引**。

| 包 id | 角色 | 大小 |
|---|---|---|
| `arknights-amiya` | 阿米娅 | 3.7 MB |
| `arknights-kal-tsit` | 凯尔希 | 6.2 MB |
| `arknights-exusiai` | 能天使 | 4.6 MB |
| `arknights-silverash` | 银灰 | — |
| `arknights-ch-en` | 陈 | — |
| `arknights-surtr` | 史尔特尔 | — |
| `arknights-texas` | 德克萨斯 | — |
| `arknights-lappland` | 拉普兰德 | 2.5 MB |
| `arknights-siege` | 推进之王 | 2.2 MB |
| `arknights-eyjafjalla` | 艾雅法拉 | 3.8 MB |
| `arknights-saria` | 塞雷娅 | 2.5 MB |
| `arknights-blaze` | 煌 | 4.1 MB |

烘焙参数 `--scale 0.5 --fps 8`：画布落在 **~210×270**（桌宠合适尺寸），每包 2–6 MB。
**每个包都自带 `behaviors`**，下载下来就是会自己走、会坐下、会睡觉、会追光标的桌宠，不用再配。

再加角色：

```bash
node tools/arknights_pick.mjs _ark/models_data.json          # 列出热门干员 key
node tools/arknights_batch.mjs --list 391_rosmon,250_phatom --scale 0.5 --fps 8 --ver 0.2.0
```

素材库里共 **950 个干员**（另有 2151 敌人 / 96 动态立绘），换 `--list` 就能继续出。

### 素材按需拉取：Release tar + 前缀

第三方素材不随包分发，改成**首次启动自动从 Release 拉 tar 解压**。文件名带**素材源前缀**，
所以不同来源的同名素材不会互相覆盖，日志里也一眼看出这包是谁的：

| 前缀 | 来源 | 许可 |
|---|---|---|
| `arknights-` | 明日方舟（Spine 3.8，Ark-Models） | 鹰角网络 |
| `yuzusoft-` | 柚子社 Ethornell 分层立绘 | 柚子社 |
| `nctype-` | nctype/DesktopSeyana | 未声明 LICENSE |
| `aic-` | Alice in Cradle / PixelLiner (laic) | 原作者 |
| `original-` | 项目自绘（随包分发） | 本仓库 |

命名 → `<prefix>-<slug>-<version>.tar.gz`，解压到 `assets/packs/<prefix>-<slug>/`。

`assets/packs-index.json` 是发布描述（随包装船）：

```jsonc
{ "id": "arknights-amiya", "prefix": "arknights", "url": "https://github.com/.../arknights-amiya-0.2.0.tar.gz",
  "bytes": 15382373, "sha256": "4bf3803a...", "files": 143, "license": "角色素材版权归鹰角网络..." }
```

运行时（Electron 主进程 `electron/packs.js`）：启动后**后台**逐个检查 → 缺才拉 → 校验大小与
**sha256** → 解压到 `assets/packs/<id>/` → 有 `pack.json` 才算成功，失败就删干净不留半成品。
**tar 是外部输入，解压前做路径穿越检查**（拒绝 `..` 逃出目标目录）。

发布流程：

```bash
node tools/pack_archive.mjs --pack assets/packs/amiya --slug amiya --ver 0.2.0 \
  --out dist-packs --base-url https://github.com/<你>/cute-pet/releases/download/packs-0.2.0 \
  --index assets/packs-index.json
gh release create packs-0.2.0 dist-packs/*.tar.gz
npm run dist        # 打包时带上 assets/packs-index.json
```

实测（本地起 HTTP 当下载源）：`--sync-packs` → `拉取 arknights-amiya (14.7 MB)` →
`已安装 arknights-amiya (143 个文件)` → 渲染 + 日常活动全部正常，窗口从 x=1128 追光标追到 x=121。

### Android 侧同样是按需拉取（APK 0.5 MB）

`webview/android/src/rust/cute_pet/PackFetcher.java` 与 Electron 侧同一套约定：
`HttpURLConnection` 下载 → 校验 bytes/**sha256** → `GZIPInputStream` + 自写 ustar 解压
（**同样做路径穿越防护**）→ 落到 `getExternalFilesDir()/assets/packs/<id>/`。

三处配套改动：

1. **APK 不再内置第三方素材**：`build.ps1` 只拷 `chibi` + `packs-index.json`，
   APK 从 **55 MB 降到 0.5 MB**。
2. **WebView 先查用户目录再回落 assets**：`shouldInterceptRequest` 对 `/assets/packs/*`
   先找 `getExternalFilesDir`，找不到才回落到 APK 内置。顺序不能反——内置的只有自绘占位图。
3. **自动选包**：按目录名排序取第一个可用包（`arknights-…` < `chibi` < `nctype-…`），
   所以只要下过角色包就用角色包；下载完成时若当前还在用占位图会自动切换。

实测（模拟器 API 36，走真实 GitHub Release）：

```
[packs] 素材同步: 新增 13 / 跳过 0 / 失败 0
overlay started, pack=arknights-amiya
[renderer] ready[webview]: arknights-amiya window=239x277
[renderer] behavior: -> idle (start) [Relax] -> interacting -> idle
```

![Android](docs/android_hot.png)

用户自己的素材也可以直接放进去（`asar: false`，是普通目录不是密封包）：

| 平台 | 放置位置 |
|---|---|
| Windows | `<安装目录>\resources\app\assets\packs\<包名>\pack.json` |
| Android | `/sdcard/Android/data/rust.cute_pet/files/assets/packs/` |

## 已验证（都是实测，不是声称）

| 项 | 方法 | 结果 |
|---|---|---|
| 渲染 + 透明 alpha | 渲染层自截图 `docs/verify_render.png` | 128×128，小人正常，背景全透明 |
| 逐像素点击穿透 | 移动光标到透明角落/不透明身体，读窗口 `WS_EX_TRANSPARENT` 扩展样式 | 角落 `True`(穿透) / 身体 `False`(可点) → **PASS** |
| 素材包播放 | `chibi.placeholder` pack，8 帧 idle | 帧序列按 tick 推进正常（128×128） |
| laic 素材源契约 | `fixtures/laic/` 用真实命名 + `laic frame --json` 结构回归 | 解析出 2 clips / 3 directions / 4 帧，**每帧 crf60 精确保留**（9 / 3 / 5 / 2） |
| Ethornell 分层合成 | 丛雨 set a 全量素材（66 图层 / 2.03MB） | [verify_render.png](docs/verify_render.png) 分层正确（发丝盖层、和服、面部） |
| 变体切换（表情） | 同一次构建分别截 `--face=01/02/13` 后逐像素比对 | 01↔02 差 **590px**、01↔13 差 **530px**、02↔13 差 **315px** → 切换真实生效 |
| 变体切换（腮红） | `--face=01` vs `--face=01h` | 差 **601px** → [blush_01h.png](docs/blush_01h.png)，见下方「修掉的两个上游 bug」 |
| **Spine 3.8 素材源** | 明日方舟 `002_amiya` 真实模型（.skel/.atlas/.png）烘焙 3 段动画 | 81 帧统一 344×554，[spine_flip.png](docs/spine_flip.png) 姿势正确（Y 轴翻转修复） |
| **内容层与宿主解耦** | 去掉 Electron preload（`--no-bridge`），内容层必须自己降级 | 日志 `ready[browser]`，主进程截 [verify_nobridge.png](docs/verify_nobridge.png) 正常 |
| **DesktopSeyana 素材源** | 克隆 nctype/DesktopSeyana（真素材 82MB），按它的 `animation_manifest.json` + `atlas_animator.gd` 契约导入 | 38 个 clip / **3136 帧** / 38.6MB；两个宿主都渲染出同一帧（[godot](desktop_pet/docs/godot_seyana.png) / [electron](docs/seyana_electron.png)） |
| **热门角色素材包** | 12 个干员批量烘焙，抽查渲染 | 12/12 成功，每包 2–6 MB 且自带行为表；能天使渲染 mesh 完整（光环+翅膀） |
| **素材按需拉取** | 起本地 HTTP 当 Release 源，删掉本地包后 `--sync-packs` | 下载 14.7MB → sha256 校验 → 解压 143 文件；下载来的包渲染 + 日常活动均正常 |
| **日常活动状态机** | seyana 包跑 24s，读窗口轨迹 | 状态按权重自主流转（idle→food_01→idle→walking→idle→chasing），窗口从 x=1234 走到 x=42 |
| **Android 悬浮窗** | 真机级验证：Android 模拟器（1080×2400, API 36）安装 APK → 点「启动桌宠」→ 回桌面截图 | 日志 `ready[webview]: chibi.placeholder window=128x128`，[android_shot3.png](docs/android_shot3.png) 桌宠透明悬浮在启动器上 |

## 穿透为什么要主进程轮询光标

第一版用 DOM `mousemove` + `setIgnoreMouseEvents(true, {forward:true})`，实测**失败**：
窗口一旦处于 `WS_EX_TRANSPARENT`，就不直接收鼠标消息，只能指望 Electron 的 forward 鼠标钩子，
而它不保证把 move 事件送达渲染层 → 穿透状态永远翻不回来，小人变成永久不可点。

改成主进程 `setInterval` 每 16ms 读 `screen.getCursorScreenPoint()`，减去窗口位置得到局部坐标推给渲染层做 alpha 命中测试。
确定性、不依赖平台钩子。DOM `mousemove` 作为窗口可交互时的快路径保留（两条路都走同一个幂等 `applyHit`）。

## 修掉的两个上游 bug

重写时对照 `pet/src/voice/mod.rs` 逐行核实语义，发现两处并已修正：

1. **同 z 序图层顺序不确定**：原实现用 `items.values()`（Rust `HashMap`）遍历，
   同 `z` 的图层先后顺序每次运行都可能不同。本项目改用 manifest 的 JSON 键序，
   稳定可复现。
2. **40 个腮红表情全部失效**：`selected_layers` 里 `f.layer.split_once('/')` 对
   `"01h".."40h"` 这类**裸层名**（值为 `頬`）返回 `None` 就直接 `continue` 跳过。
   实测 `face 01h` 与 `face 01` 逐像素完全一致 —— 腮红从来没画出来过。
   按 Ethornell 语义回退到 `group == 0` 找同名层后，差异 601px，腮红正常。

## Spine 导出的大坑：默认丢掉所有 mesh（「人物渲染不全」的根因）

`spine-canvas` 的 `SkeletonRenderer` 构造函数里写死了：

```js
function SkeletonRenderer(context) {
    this.triangleRendering = false;   // ← 默认 false
    ...
}
SkeletonRenderer.prototype.draw = function (skeleton) {
    if (this.triangleRendering) this.drawTriangles(skeleton);
    else this.drawImages(skeleton);          // ← 走这条
};
SkeletonRenderer.prototype.drawImages = function (skeleton) {
    ...
    if (attachment instanceof spine.RegionAttachment) { ... }
    else continue;                            // ← 非 region 全部静默跳过
};
```

明日方舟小人**大量使用 MeshAttachment**（002_amiya：15 个槽位在 **142/142 帧**里全是 mesh，
包括头发、马尾、围巾、外套前后摆、腰带、裙摆）。默认路径把它们全部丢弃，
渲染出来是个「没头发、没围巾、没裙子」的残缺小人，而且**不报任何错**。

修复：`renderer.triangleRendering = true`。A/B 实测（[spine_ab.png](docs/spine_ab.png)）：
不透明像素 46295 → 54259，**补回 7964 像素**，15023 个像素 alpha 有变化。

同一批修复里还修了：`--max-frames` 硬编码 60 把 `Sit`(8.00s → 需 80 帧) 静默截成 60 帧
（出来是跳回开头的残缺循环）；默认只挑 idle 类动画导致 6 段只导出 3 段。
现在默认**不截断**、**导出全部动画**，要限帧必须显式传参且会打印警告。

## 修掉的第三个上游 bug：spine-canvas 从不应用混合模式

`spine-canvas` 的 `drawTriangles` 里有这么一段：

```js
var slotBlendMode = slot.data.blendMode;
if (slotBlendMode != blendMode) {
    blendMode = slotBlendMode;      // ← 赋值完就没下文了
}
```

**全文件 `globalCompositeOperation` 出现 0 次** —— 混合模式被解析、被追踪，然后被丢掉。
所以 Additive(1)/Multiply(2)/Screen(3) 的槽位一律按 Normal 画。明日方舟「动态立绘」实测有
**20 个 Additive 槽位**（发光/特效层），全都会失真。

补丁：[tools/patch_spine_canvas.mjs](tools/patch_spine_canvas.mjs)（幂等，可重复执行）——
per-slot 设置 canvas 2D 的混合模式，并在收尾复位。

A/B 实测（动态立绘 Idle 第 0 帧，[illust_ab.png](docs/illust_ab.png)）：

| | 值 |
|---|---|
| 通道差 >8 的像素 | **3250（5.99%）** |
| 最大通道差 | 111 |
| alpha 总和 | 5703473 → 5744752 |

## 动态立绘：撞上 node-canvas 的内存墙（**未完成**）

顺手试了把「动态立绘」（干员动态立绘，比基建小人好看得多）也烘焙成素材包。**结论：这条路走不通，
已从 Release 撤回**。

- 模型规模：**279 个 MeshAttachment**、2452² 贴图、539 根骨骼（基建小人只有 15 个 mesh）
- 现象：单段动画渲染若干帧后 `createCanvas`/`toBuffer` 抛 `out of memory`；
  与画布尺寸**无关**，只与累计渲染帧数有关
- 试过的办法及结果（全部实测）：

| 办法 | 结果 |
|---|---|
| 加大 Node 堆（`--max-old-space-size=8192`） | 无效 → 不是 JS 堆，是 cairo 原生内存 |
| 降帧率/降分辨率（fps 2、scale 0.06） | 能过，但只有 8 帧、动画废了 |
| 定期重建 canvas/context | **负优化**：每次 `createCanvas` 新增一张 cairo surface，只增不减 |
| 每段动画独立进程 + 共享包围盒 | 仍然 OOM |

期间还踩到一个**自己造成的**坑：重建 `Renderer` 后忘了重设 `triangleRendering = true`，
于是首帧正常、**后续帧全空白**（279 个 mesh 又被静默丢掉）。已修，并由
「首帧 106KB / 次帧 115KB」的字节数核对确认。

**正解**：走 GPU 渲染（Electron + Pixi7 + `pixi-spine@4.0.6`，也就是你 `Stronghold-Protocol`
客户端那条路：一个包同时带 3.7/3.8/4.0/4.1 四个运行时，并且天然支持 clipping 的 stencil mask
与全部混合模式）。这需要把导出器从 node-canvas 换成离屏 WebGL，**尚未开始**。

## Android 壳的六个坑（全部实测踩到并修掉）

0. **漏 `INTERNET` 权限**：`HttpURLConnection` 抛 `SecurityException: Permission denied
   (missing INTERNET permission?)`，13 个素材包全失败、状态栏只显示「失败 13」。
   logcat 里一开始还看不到——因为 `MainActivity` 那条路径只写 TextView 不写日志，补了 `say()` 才现形。
0. **内部接口名 `Log` 遮住了 `android.util.Log`**：`Log.i(TAG, …)` 编译报「找不到符号」，
   要用全限定名 `android.util.Log.i`。


1. **aapt2 在 Windows 上把 asset 条目名写成反斜杠**（`assets\web\src\index.html`），
   而 `AssetManager` 只认正斜杠 → `assets.open("web/src/index.html")` 永远失败。
   改为不用 `aapt2 -A`，由 `jar uf -C <work> assets` 追加（jar 会规范化成 `/`）。
2. **javac 在中文 Windows 上默认按 GBK 读源码**，UTF-8 的中文注释直接编译失败（47 个错误）。
   加 `-encoding UTF-8`。
3. **`@JavascriptInterface` 跑在 JS 桥线程，不是 UI 线程**：在里面直接改
   `WindowManager.LayoutParams` + `updateViewLayout` 会抛 `CalledFromWrongThreadException`
   把进程打崩，日志表现为「桌宠一启动就崩、服务被系统反复重启」。所有窗口操作必须
   `Handler(Looper.getMainLooper()).post(...)` 回主线程。
4. **WebView 没有 viewport meta 时按 980px 视口缩放**，128px 的画布被缩成十几像素的小点；
   另外 `WindowManager` 用的是物理像素而 JS 给的是 CSS 像素，要乘 `devicePixelRatio`。

## 踩坑记录

- **`ELECTRON_RUN_AS_NODE=1` 会被宿主继承**：此时 `require('electron')` 返回二进制路径字符串而非 API，
  报 `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`。`run.cmd` 已处理。
- **`file://` 下 ES module 会被 CORS 拦**：所以主进程注册了 `pet://` 自定义协议（`standard+secure+supportFetchAPI`），
  页面从 `pet://app/src/index.html` 加载，`fetch` 与同源 canvas 读像素才不被污染。
- **`node_modules` 通过 `/vendor/` 映射**：`import * as PIXI from '/vendor/pixi.js/dist/pixi.mjs'`，无需打包器。
