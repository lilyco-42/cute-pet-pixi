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

## 关于重 mesh 模型的 out of memory

很重的模型（动态立绘）在 node-canvas 上会 OOM，而且**与画布尺寸无关、只与累计帧数有关** ——
说明吃的是 cairo 原生内存而不是 JS 堆（所以 `--max-old-space-size` 无效）。

尝试过的办法与结果：

| 办法 | 结果 |
|---|---|
| 加大 Node 堆 | 无效（不是 JS 堆） |
| 降帧率/降分辨率 | 能过但动画废了（只有 8 帧） |
| 定期重建 canvas/context | **负优化**：每次 `createCanvas` 新增一张 surface，只增不减 |
| 每段动画独立进程 + 共享包围盒 | 有效，已实现（`--scan-only` / `--bounds-json` / `--merge`） |

当前做法：`arknights_batch.mjs` 先扫一次共享包围盒，再**一段动画起一个进程**，
最后用 `--merge` 合并 `pack.json`。CI 机器内存更宽裕，能扛住更重的模型。

**正解**是把导出器从 node-canvas 换成离屏 WebGL（Electron + Pixi7 + `pixi-spine@4.0.6`），
那样还能一并支持 clipping 的 stencil mask 与全部混合模式。**尚未开始。**
