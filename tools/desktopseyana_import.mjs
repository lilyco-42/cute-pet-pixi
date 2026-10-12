#!/usr/bin/env node
// DesktopSeyana (nctype/DesktopSeyana) -> 统一资产包 pack.json
//
// 它的素材契约（读 assets/animation_manifest.json + scripts/atlas_animator.gd 核实）：
//   {
//     "canvas_size": [263,263], "columns": 4, "frames_per_sheet": 16,
//     "clips": {
//       "seyana/02_idle/animation/idle_loop_01": {
//         "sheets": ["res://assets/animations/..._sheet_s00.pngdata", ...],   // 4x4 网格, 每格 263x263
//         "frame_count": 50, "frames_per_sheet": 16, "columns": 4,
//         "frame_size": [263,263],
//         "frame_durations_ms": [16.6667, ...]                                 // 逐帧时长
//       },
//       "seyana/04_wakling/animation/walking_slow": { "frames": ["res://.../walking_slow_000.pngdata", ...] }
//     }
//   }
//
// 两个要点：
//   1. 贴图扩展名是 .pngdata —— 仍是标准 PNG 字节，只是避开 Godot 的导入系统。
//   2. frame_durations_ms 是**逐帧**时长，16.667ms = 1/60s，正好等于本项目的 tick 单位，
//      所以 ticks = round(ms / (1000/60))，不会引入额外舍入。
//
// 用法：
//   node tools/desktopseyana_import.mjs --repo <DesktopSeyana> --character seyana --out assets/packs/seyana
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from 'canvas';

const TICK_MS = 1000 / 60;

export function msToTicks(ms) {
  return Math.max(1, Math.round(Number(ms) / TICK_MS));
}

/** 把精灵表切成单帧 PNG buffer（行优先，与 atlas_animator.gd 的 local_frame 公式一致）。
 *  注意：**最后一张表通常是残表**（entrance 102 帧 ÷ 16 = 7 张，第 7 张只有 2 行），
 *  所以按图片实际高度算行数，而不是按 frames_per_sheet 算。 */
export async function sliceSheet(file, columns, frameW, frameH) {
  const img = await loadImage(fs.readFileSync(file));
  if (img.width % frameW !== 0) {
    throw new Error('sheet 宽度不是帧宽整数倍: ' + file + ' ' + img.width + ' / ' + frameW);
  }
  const cols = img.width / frameW;
  const rows = img.height / frameH;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cv = createCanvas(frameW, frameH);
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, frameW, frameH);
      ctx.drawImage(img, c * frameW, r * frameH, frameW, frameH, 0, 0, frameW, frameH);
      out.push(cv.toBuffer('image/png'));
    }
  }
  return out;
}

function resToAbs(repo, resPath) {
  return path.join(repo, String(resPath).replace(/^res:\/\//, ''));
}

export async function buildPack(repo, character, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'animation_manifest.json'), 'utf8'));
  const outDir = path.resolve(opts.out);
  const framesDir = path.join(outDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const clips = Object.entries(manifest.clips).filter(([k]) => k.split('/')[0] === character);
  if (!clips.length) throw new Error('该角色没有 clip: ' + character);

  const animations = {};
  let canvas = null;
  let total = 0;
  const report = [];

  for (const [key, data] of clips) {
    const id = key.split('/').pop();
    const frameSize = data.frame_size || manifest.canvas_size || [263, 263];
    canvas = canvas || { width: frameSize[0], height: frameSize[1] };
    const durations = data.frame_durations_ms || [];
    const count = Number(data.frame_count || 0);

    let pngs = [];
    if (Array.isArray(data.frames) && data.frames.length) {
      // 逐帧序列
      pngs = data.frames.map((p) => fs.readFileSync(resToAbs(repo, p)));
    } else if (Array.isArray(data.sheets) && data.sheets.length) {
      const columns = Number(data.columns || manifest.columns || 4);
      for (const s of data.sheets) {
        const part = await sliceSheet(resToAbs(repo, s), columns, frameSize[0], frameSize[1]);
        pngs.push(...part);
      }
    } else {
      report.push(id + ': 既无 sheets 也无 frames，跳过');
      continue;
    }
    const want = count > 0 ? count : pngs.length;
    if (pngs.length < want) report.push(id + ': 素材只有 ' + pngs.length + ' 帧 < frame_count ' + want);
    pngs = pngs.slice(0, want);

    const frames = pngs.map((buf, i) => {
      const file = id + '_' + String(i).padStart(3, '0') + '.png';
      fs.writeFileSync(path.join(framesDir, file), buf);
      const ms = durations.length ? durations[Math.min(i, durations.length - 1)] : TICK_MS;
      return { ticks: msToTicks(ms), layers: [{ src: 'frames/' + file, x: 0, y: 0 }] };
    });
    total += frames.length;
    // 含 loop / idle 的走循环；其余是一次性片段（本项目的运行时暂时统一循环，
    // 这个字段留给以后做动作状态机用）
    const loop = /loop|idle/i.test(id);
    animations[id] = { loop, directions: { '0': { frames } } };
    report.push(id.padEnd(22) + frames.length + ' 帧  loop=' + loop);
  }

  const pack = {
    schema: 1,
    id: opts.id || ('desktopseyana.' + character),
    format: 'frames',
    canvas,
    scale: Number(opts.scale || 1),
    anchor: { x: 0.5, y: 1.0 },
    hitThreshold: 90,
    source: {
      kind: 'desktopseyana',
      note: 'nctype/DesktopSeyana 预渲染帧序列（.pngdata 精灵表）。该仓库未声明 LICENSE，素材版权归原作者，不要随商业包分发',
      character,
      tickMs: TICK_MS,
    },
    animations,
  };
  fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify(pack, null, 2));
  return { pack, report, total, framesDir };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.repo || !a.out) {
    console.error('用法: node tools/desktopseyana_import.mjs --repo <DesktopSeyana> [--character seyana] --out <packdir> [--scale 1]');
    process.exit(2);
  }
  const character = a.character || 'seyana';
  const res = await buildPack(path.resolve(a.repo), character, {
    out: a.out, scale: a.scale, id: a.id,
  });
  for (const line of res.report) console.log('  ' + line);
  console.log('pack.json -> ' + path.resolve(a.out, 'pack.json'));
  console.log('  canvas ' + res.pack.canvas.width + 'x' + res.pack.canvas.height +
    ' | clip ' + Object.keys(res.pack.animations).length + ' 个 | 总帧数 ' + res.total);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('失败: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
}
