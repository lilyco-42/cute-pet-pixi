# CI 构建矩阵

> 本项目的纪律：**本机不编译、不烘焙**。所有产物一律由 GitHub Actions 产出，
> 本机只负责写代码。这样做的直接好处是构建环境可复现，且不会因为本机的
> node-canvas / cairo / SDK 版本差异得到不同结果。

## 工作流一览

| 工作流 | 触发 | 产物 | 说明 |
|---|---|---|---|
| `desktop.yml` | push main / tag / 手动 | `cute-pet-windows`（NSIS + MSI，~195 MB） | Electron 宿主 |
| `android-shell.yml` | push main / PR / 手动 | `cute-pet-shell-apk`（~0.5 MB） | 纯 framework WebView 壳 |
| `bake-packs.yml` | 手动（需填参数） | `baked-packs-<ver>` + 挂到 `packs-<ver>` Release | Spine 模型批量烘焙 |

## 每个工作流都先跑「便宜的门禁」

这是从 `lilyco-42/cute-pet` 抄来的结构：真正的打包要几分钟到十几分钟，
而绝大多数回归（语法错、JSON 字段漏、桥方法名漂移）可以在几十秒内发现。

- `desktop.yml` 的 `check`：`node --check` 全部源文件 + `scripts/verify_packs.sh`
- `android-shell.yml` 的 `check`：`javac` 编三个类 + 桥方法名与页面侧比对
- `bake-packs.yml`：烘焙后 `grep FAIL` 直接判红，不给「部分成功」蒙混过关

## 产物校验是断言，不是走过场

`webview/android/verify_apk.sh` 有 **17 条断言**，分六类：

1. **结构**：classes.dex、Web 内容层、素材索引、内置 chibi、pixi.js、manifest
2. **合规**：APK 内不得出现 `arknights-*` / `nctype-*` / `yuzusoft-*` 素材
3. **依赖**：必须是单一 dex、无 native 库（本壳刻意零第三方、零 Gradle）
4. **接线**：dex 里必须有 `OverlayService` / `MainActivity` / `PackFetcher` /
   `PetBridge` / `pickPack` / `reloadPack` / `shouldInterceptRequest`
5. **权限**：`INTERNET` 必须声明（漏了会让全部素材包静默下载失败）
6. **体积**：超过 5 MB 说明素材被误编进去了

它还带 `--selftest`：**先证明自己会失败** —— 抠掉 `classes.dex` 后必须 exit 1。
一个永远返回 0 的校验脚本比没有校验更糟，因为它给的是假安心。

## 踩过的坑（都已在代码里注释）

### 1. 行尾注释会让 .gitignore / .gitattributes 规则静默失效

```gitignore
/models/          # 下载的 Spine 模型原件
```

上面这条**永远不会匹配** —— git 把 `# 下载的...` 当成模式的一部分。
`.gitattributes` 更直接：报 `is not a valid attribute name`。
结果：45 MB 第三方版权素材差点进了仓库。

### 2. strings | grep 读不到二进制 XML 里的权限

```bash
# 永远为假：AndroidManifest.xml 是二进制 XML，字符串池是 UTF-16LE，还被 DEFLATE 压过
unzip -p app.apk AndroidManifest.xml | strings | grep INTERNET
```

实测：`method=8(DEFLATE) csize=899 usize=2568`，解压后 UTF-16LE 能扫到
`ACCESS_NETWORK_STATE` / `INTERNET` / `SYSTEM_ALERT_WINDOW`，UTF-8 扫到空。
正解见 `webview/android/apk_has_permission.mjs`。

### 3. Android SDK 的工具不在 PATH 里

`aapt2` / `d8` / `zipalign` / `apksigner` 都在 `$SDK/build-tools/<ver>/` 下，
不 `export PATH` 就是 `command not found` + `exit 127`。

### 4. android-actions/setup-android@v3 会死在 tools 包上

它第一步执行 `sdkmanager "tools" "platform-tools"`，而新版 SDK **已移除 `tools` 包**，
报 `Failed to find package 'tools'` 后 `exit 1`，整个 job 在真正编译之前就死了。
改为直接复用 runner 预装 SDK，只补 `platforms;android-36` + `build-tools;36.0.0`。

### 5. javac 在中文 Windows 上默认 GBK

UTF-8 源码直接炸出 47 个错。所有 `javac` 调用都必须带 `-encoding UTF-8`。

### 6. chibi 的 pack.json 一直没有 behaviors

`src/assets/pack.js` 里是 `behaviors: raw.behaviors || null`，缺字段时行为引擎**直接不启动**：
表现是「桌宠站着不动」，而且不报任何错。这是静默降级，很难查。
`scripts/verify_packs.sh` 现在会把这个抓出来，并进一步校验
`behaviors` 引用的 clip / after / weights 是否真实存在。

## 手动烘焙素材包

```bash
gh workflow run bake-packs.yml --repo lilyco-42/cute-pet-pixi \
  -f models=2023_ling,2012_typhon,1029_yato2 \
  -f kind=operator -f scale=0.5 -f fps=8 -f version=0.3.0
```

- `kind=operator`：基建小人（约 45 个 mesh，scale 用 0.5）
- `kind=illust`：动态立绘（279 个 mesh / 2452² 贴图，scale 用 0.12）
- `fps=8` 对应 `ticks=8`（ticks 单位是 1/60 秒）

烘焙完会自动 `gh release upload packs-<ver>`，仓库里**不留**任何第三方素材。

## 重 mesh 模型的 "out of memory"：已定位并修复

重 mesh 模型（动态立绘 279 个 MeshAttachment）导出时会抛 `out of memory`。
**那个错误信息是误导性的 —— 根本不是内存不足。**

### 排除法定位（每步都是 CI 实测）

| 假设 | 证据 | 结论 |
|---|---|---|
| 内存耗尽 | frame 0→14 rss 稳定 **97 MB**、heap 16 MB（机器 16 GB） | 排除 |
| 画布尺寸超限 | scale 0.08~0.5 **全部**复现，197×219 也一样挂 | 排除 |
| surface 状态坏 | 重建 canvas 后重试**仍然失败** | 排除 |
| 几何数据坏 | 91 附件 / 272 骨骼 / 0 非有限值 / maxAbs 216~894 全正常 | 排除 |
| **cairo 的 PNG 编码器** | 同一帧 `getImageData` 正常（17214 个不透明像素），`toBuffer` 却抛 OOM | **确认** |

关键判别实验是 `--png-probe`：在 `toBuffer()` 之前先 `getImageData()`。

- 若 `getImageData` 也挂 → surface 本身有问题
- 若它过、`toBuffer` 挂 → **是 PNG 编码器的问题**（实测就是这个）

### 修复

既然像素数据是好的，就绕开 cairo 的编码器**自己封 PNG**：

```
IHDR + IDAT(zlib.deflateSync) + IEND
每行前置一个 filter 字节 0x00 (None)
CRC32 按 PNG 规范显式实现（多项式 0xEDB88320）
```

验证（CI）：

```
检查 43 个 PNG
尺寸: 197x219
解不开: 0   空帧: 0
PNG 自检通过
```

`SEG`/`RETRY`（失败与重试）出现 **0 次** —— OOM 彻底消失。

### 自己写的东西必须被独立验证

`tools/verify_png.mjs` 用 node-canvas **反解**产物，验三件事：能读、尺寸对、非全透明。
否则会产出「能生成但读不了」的文件，一路漏到运行时只表现为画面空白。
该自检已接进诊断 workflow（`if: always()`）。

### 诊断开关一览

| 开关 | 作用 |
|---|---|
| `--mem-probe N` | 每 N 帧打印 rss/heap/external |
| `--geo-probe` | `toBuffer` 前检查非有限值与最大量级 |
| `--png-probe` | 先 `getImageData` 判别编码器 vs surface |
| `--self-png=false` | 回退到 cairo 的 `toBuffer`（A/B 对照） |
| `--images-only` | 关掉三角形渲染（复现「mesh 被静默跳过」的旧行为） |
| `--recycle N` | 每 N 帧重建 canvas（**实测是负优化**，默认关） |

### 仍然有效的工程做法

`arknights_batch.mjs` 先扫一次共享包围盒，再**一段动画起一个进程**，
最后用 `--merge` 合并 `pack.json`。这仍然有价值：单进程内 cairo 的累积确实存在，
分进程能让失败被隔离到单个动画，而不是毁掉整包。

### 未做的事

换成离屏 WebGL（Electron + Pixi7 + `pixi-spine@4.0.6`）能一并支持 **clipping 的 stencil mask**
与全部混合模式，那才是更彻底的路。当前 node-canvas 路径已经够用，**换渲染器尚未开始**。
