# vendor/spine-3.8 —— 官方 Spine 运行时（原样，未修改）

## 来源

上游：<https://github.com/EsotericSoftware/spine-runtimes>，tag **3.8.95**。
取的是 `spine-ts/build/` 下的预编译产物，不是源码。

| 文件 | 上游路径 | 大小 | sha256（前 16 位） |
|---|---|---|---|
| `spine-core.js` | `spine-ts/build/spine-core.js` | 291 KB | `31d2dba23ab3dd33` |
| `spine-canvas.js` | `spine-ts/build/spine-canvas.js` | 301 KB | `ad0499790bac51f8` |
| `spine-webgl.js` | `spine-ts/build/spine-webgl.js` | 410 KB | `91ec70eca4973bb9` |
| `*.d.ts` | 同目录类型声明 | — | — |

## 为什么是 3.8.95 而不是 npm 上的 4.x

明日方舟的模型锁定 **Spine 3.8**（实测 skeleton version = `3.8.99`）。
而 npm 上的 `@esotericsoftware/spine-canvas` / `spine-webgl` 只从 **4.0.1** 起发布，
3.8 拿不到 —— 只能用官方仓库 tag 的预编译产物。

## 这两个渲染器的能力差异（实测）

| | spine-canvas | spine-webgl |
|---|---|---|
| 渲染后端 | cairo（CPU） | WebGL（GPU） |
| `stencil` 相关代码 | **0 处** | 有（Clipping 38 处） |
| ClippingAttachment | 只解析、**不生效** | 生效（GPU 模板遮罩） |
| blendMode | 需要打补丁（见 `tools/patch_spine_canvas.mjs`） | 原生支持（16 处） |
| 依赖 | node-canvas（要系统 cairo） | 需要 GL 上下文 |

所以：**默认走 canvas**（快、依赖少），**用了 clipping 的模型走 webgl**。
用 `tools/spine_features.mjs` 可以量出哪些模型需要后者。

## 许可

Spine Runtimes 的授权见同目录 `LICENSE`。
**使用运行时需要持有 Spine 编辑器授权** —— 这是上游的许可要求，与本仓库代码的 MIT 无关。
角色素材本身的版权归鹰角网络，见根目录 `THIRD-PARTY-NOTICES` 的说明。
