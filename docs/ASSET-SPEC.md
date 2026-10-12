# 统一资产包规范 (Asset Pack Spec v1)

> 目标：**新增素材源时永不改运行时**。
> 运行时只会做两件事：按 tick 切帧、按 x/y 叠层。所有格式差异都在离线导入器里消化。

## 1. 中间表示

```jsonc
{
  "schema": 1,
  "id": "laic.noel",
  "format": "frames",                    // frames | spine | live2d（后两者是运行时适配，不走此结构）
  "canvas": { "width": 128, "height": 128 },
  "anchor": { "x": 0.5, "y": 1.0 },      // 窗口锚点，换素材不跳位
  "hitThreshold": 90,                    // alpha >= 90/255 视为可点击
  "animations": {
    "walk": {
      "loop": true,
      "directions": {                      // 方向按素材源原样保留（laic 是 d0..d7）
        "0": { "frames": [
          { "ticks": 3, "layers": [ { "src": "noel.walk.d0.f0.png", "x": 0, "y": 0 } ] },
          { "ticks": 5, "layers": [ { "src": "noel.walk.d0.f1.png", "x": 0, "y": 0 } ] }
        ]}
      }
    }
  }
}
```

关键点：
- **`ticks` = 1/60 秒**。这不是自造单位：laic 的 `crf60` 就是它，PixelLiner 的 `FrameAnimator` 也是它。
  用同一个单位，跨素材源合成时不会累积舍入误差。
- **一帧可以有 N 层**（`layers[]`）。单层帧序列是 N=1 的退化情形；
  Ethornell 那种「背景/身体/表情/服装」分层合成是 N>1 的一般情形。两者同一个模型。
- 命中测试用的是**该帧合成后的 alpha**，所以分层素材也能做到逐像素穿透。

## 1b. 第二种形态：`format: "variants"`（可交互分层立绘）

帧序列适合「一段动画」，但 Ethornell 那种立绘需要**实时换装/换表情**，烘焙成 1020 个姿势
（10 服装 × 102 表情）既臃肿又丢掉交互性。所以第二种形态把「变体选择」交给运行时：

```jsonc
{
  "format": "variants",
  "canvas": { "width": 817, "height": 1469 },   // 角色轮廓 bbox（原生像素）
  "scale": 0.3333,                               // 运行时缩放 -> 窗口 272x490
  "idle": { "bobAmplitude": 4, "bobSpeed": 1.2 },// 待机上下浮动
  "variants": {
    "dress": { "default": "私服|1", "options": [ { "id": "私服|1", "label": "私服", "layers": [ /* x,y,w,h,z,alpha */ ] } ] },
    "face":  { "default": "01",     "options": [ { "id": "01",      "layers": [ ... ] } ] }
  }
}
```

运行时场景 = `dress 层 ++ face 层`，按 `z` **稳定排序**（同 z 保持先服装后表情）。
绘制顺序 z 规则（照抄原实现）：`2 = 髜かぶせ(头发盖层)` / `1 = 表情组` / `3 = 其它非 0 组(泪·腮红)` / `0 = 身体服装`。

命中测试不再是「整画布预合成 alpha」，而是**从最上层往下逐层取该层自身的 alpha**
（每层只一两百像素见方，用 WeakMap 缓存）。否则 1800×2550 的画布每帧要过 460 万像素。

## 2. 各素材源如何映射

| 素材源 | 导入方式 | ticks 来源 | 备注 |
|---|---|---|---|
| **laic / PixelLiner** (Alice in Cradle) | `tools/laic_import.mjs` | `laic frame --json` 的 `crf60` | 文件名契约 `<table>.<pose>.d<dir>.f<idx>.png`，已对照 `lilyco-aic/src/render.rs` 源码核实 |
| **纯 PNG 帧序列 / GIF / 精灵表** | 直接手写 pack.json；精灵表切片逻辑见 `tools/desktopseyana_import.mjs` 的 `sliceSheet()` | 自定（默认 4） | 最通用兜底 |
| **DesktopSeyana**（nctype，セヤナー） | `tools/desktopseyana_import.mjs` | 它的 `frame_durations_ms`（16.667ms = 1 tick） | 两种形态都吃：`sheets` 精灵表（4×4 网格，**末张常是残表**）+ `frames` 逐帧序列；贴图扩展名是 `.pngdata` 但内容是标准 PNG |
| **Ethornell `.chr`**（柚子社） | `tools/ethornell_import.mjs` | 静态（无帧时长） | 已实现并跑通丛雨 set a：10 套服装 × 102 表情，见 §1b |
| **Spine 3.8**（明日方舟 Ark-Models） | `tools/spine_export.mjs`（官方 3.8.95 运行时离线烘焙） | 由 `--fps` 决定（默认 10 → 6 ticks） | 已跑通 002_amiya 全 6 段动画 142 帧，见 §3 |
| **Live2D Cubism 2/4** | 见 §3 | 自定 | |

## 3. Spine 3.8 / Live2D：两条路，按「要不要保留交互性」选

### 更正：Spine 3.8 的运行时其实有 npm 包

我之前写「3.8 不发布到 npm」是错的 —— 那只针对 `@esotericsoftware/spine-*`（确实 4.0.1 起）。
**`pixi-spine@4.0.6` 内部就是 `@pixi-spine/runtime-3.8@4.0.6`**，能直接跑 3.8 模型；
你的 `Stronghold-Protocol` 客户端用的正是 `pixi-spine@4.0.6 + pixi.js@7.4.2`。

从你的客户端资产管线（`public/js/render/spine.js` / `docs/ASSETS.md`）里可以抄的三件事：

1. **`pma: true`**：Ark-Models 的贴图按约定是预乘 alpha，客户端给这些 atlas 打上 `pma` 标记，
   pixi-spine 读到后设 `ALPHA_MODES.PMA`。⚠️ 我实测 `002_amiya` 的 PNG **不满足** c ≤ a
   （38409 个半透明像素里有 19 个违反，最大 c/a = 1.75），疑似被重采样过 ——
   所以不要无脑当 PMA 处理，应当逐图检测。
2. **atlas 补 `size: W,H`**：fexli 来源的 atlas 缺这一行，要从 PNG 头读出来补在每个 page 名后面。
3. **干员模型是 Front / Back 两套骨架**（fexli `spine/{id}/{id}/{Front,Back}/`），
   不是一套。Ark-Models 的 `models/` 是**基建小人**（单骨架），别把两者当同一个东西。

另外客户端还处理了 `clipping`（stencil mask）与 blend mode —— 我实测的 002_amiya 两者都没有
（0 个 clipping、35 个槽位全是 normal），所以离线烘焙这条路对它够用；
遇到带 clipping/特效混合的模型时应改用 pixi-spine 而不是 spine-canvas。

### 路线 A：运行时适配（保留骨骼动画的换装/表情/眼动/物理）
导出成 `format: "spine"` / `"live2d"`，由 `src/stage.js` 之外的适配器接管渲染，
命中测试退化为**包围盒**或**周期性 GPU 回读**（不是每帧逐像素）。

- Spine 3.8：官方 `spine-ts` 有 3.8 分支；Pixi v8 下社区包 `pixi-spine` 覆盖 Spine 3.8。
- Live2D：`pixi-live2d-display`（Pixi v6 线）/ `@jannchie/pixi-live2d-display`（Pixi v8 线）。
  ⚠️ **Cubism Core（`live2dcubismcore.min.js`）不在 npm 上**，必须从 Live2D 官网 SDK 取，且受其授权条款约束。

### 路线 B：离线出帧（零运行时依赖、零跨平台差异、可发布性最好）
用官方编辑器/官方 runtime 把动画导出成 PNG 帧序列 → 走 `format: "frames"`。
代价是失去实时交互（换装/物理/眼动），换来的是**运行时体积与授权风险都可控**。

> 我的建议：**默认走 B**，只有当某个素材确实需要实时交互时才为它开 A。
> 这样「多素材兼容」不会演变成「多套运行时都要在 Windows/macOS/Linux 上各自成立」。

## 3b. 这个规范已经被两个宿主验证过

规范只在纸面上「栈无关」是没意义的。目前有两份**互不共享代码**的运行时在读同一份 pack.json：

| 宿主 | 技术栈 | 位置 | 实测 |
|---|---|---|---|
| Electron | Chromium + PixiJS 8 | `cute-pet/` | 四个素材源全通 |
| Godot 4.7 | GDScript + 引擎原生 2D | `../desktop_pet/` | 四个素材源全通 |

素材源清单：laic/PixelLiner、Ethornell 分层立绘、Spine 3.8 离线烘焙、DesktopSeyana、占位 chibi。

### 运行时的一个规模约束（实测踩到）

DesktopSeyana 那个包有 **3136 帧 / 38.6MB**。Electron 版原本在 `build()` 里一次性预加载所有帧，
结果首帧迟迟不出来，**直接撞上截图超时**。已改为惰性加载：只预载「每个 clip 的首帧」+ 变体选项，
其余播到哪载到哪（`_ensure()` 带 pending 去重，载完若正好是当前帧就补画）。
Godot 版本来就是按需 `_tex()` 加载，不受影响。

跨宿主一致性：同一个 Amiya 帧，Godot 视图与 pack 内烘焙 PNG 的不透明像素**都是 54257**，
通道差 >8 的仅 0.26%（边缘抗锯齿）。也就是说「换宿主」不影响观感，
「换素材源」也不影响宿主——这正是这套中间表示要换来的东西。

## 4. 新增一个素材源要做什么

1. 写一个 `tools/<source>_import.mjs`，产出 §1 的 pack.json；
2. 丢一份该源真实样例到 `fixtures/<source>/` 作为回归样例（照 `fixtures/laic/` 的样子）；
3. 运行时一行都不用改。
