#!/usr/bin/env node
// 把行为表写进资产包（pack.behaviors）。行为是资产的一部分，运行时只做通用解释。
//   node tools/behaviors.mjs --pack assets/packs/seyana/pack.json --profile seyana
//   node tools/behaviors.mjs --pack assets/packs/amiya/pack.json  --profile spine-min
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 抄自 nctype/DesktopSeyana：
//   scripts/pet_window.gd 的 _build_idle/_build_jumping/_build_walking/_build_chasing/
//     _build_surisuri/_build_sleeping/_build_kabuto/_build_food_*
//   scripts/app.gd 的 choose_random_action（权重表）
const IDLE = {
  phases: [
    { clip: 'idle_start', loops: 1 },
    { pick: [{ clip: 'idle_loop_02', chance: 0.08 }, { clip: 'idle_loop_01', chance: 1 }], loops: [2, 4, 6, 8] },
    { clip: 'idle_end', loops: 1 },
  ],
  after: 'choose',
};

// food_01 = エビフライ, food_02 = プロテイン(protein)，按 clip 名对应
function food(prefix) {
  return {
    phases: [
      { clip: prefix + '_start', loops: 1 },
      { clip: prefix + '_01', loops: 1 },
      { clip: prefix + '_02', loops: 1 },
      { clip: prefix + '_end', loops: 1 },
    ],
    after: 'idle',
  };
}

const SEYANA = {
  initial: 'idle',
  speed: { walk: 58, chase: 115, surisuri: 115 },
  contactRadius: 10,
  choose: {
    excludePrevious: true,
    weights: { jumping: 10, walking: 25, playing: 10, food_01: 10, food_02: 5, chasing: 15, sleeping: 15, kabuto: 10 },
  },
  states: {
    idle: IDLE,
    jumping: {
      phases: [
        { pick: [{ clip: 'jumping_01', chance: 0.5 }, { clip: 'jumping_02', chance: 1 }], loops: 1 },
        { clip: 'jumping_02', loops: 1 },
        { clip: 'jumping_01', loops: 1 },
      ],
      after: 'idle',
    },
    walking: {
      phases: [{
        pick: [{ clip: 'walking_fast', chance: 0.5, speedMul: 1.25 }, { clip: 'walking_slow', chance: 1, speedMul: 1 }],
        loops: -1,
        movement: 'walk',
        duration: [5, 12],
      }],
      after: 'idle',
    },
    playing: {
      phases: [
        { clip: 'playing_start', loops: 1 },
        { clip: 'playing_loop', loops: [3, 4, 5, 6, 7] },
        { clip: 'playing_end', loops: 1 },
      ],
      after: 'idle',
    },
    food_01: food('ebfly'),
    food_02: food('protein'),
    chasing: { phases: [{ clip: 'chasing_start', loops: -1, movement: 'chase', duration: [10, 10] }], after: 'idle' },
    surisuri: {
      phases: [
        { clip: 'surisuri_start', loops: 1, movement: 'surisuri' },
        { clip: 'surisuri_loop', loops: [2, 3, 4, 5, 6, 7], movement: 'surisuri' },
        { clip: 'surisuri_end', loops: 1, movement: 'surisuri' },
      ],
      after: 'idle',
    },
    sleeping: {
      phases: [
        { clip: 'sleep_start', loops: 1 },
        { pick: [{ clip: 'sleep_loop_01', chance: 0.5 }, { clip: 'sleep_loop_02', chance: 1 }], loops: [3, 7] },
        { pick: [{ clip: 'sleep_end', chance: 0.5 }, { clip: 'sleep_end_02', chance: 1 }], loops: 1 },
      ],
      after: 'idle',
    },
    kabuto: {
      phases: [
        { clip: 'kabuto_start', loops: 1 },
        { clip: 'kabuto_loop', loops: [1, 2, 3] },
        { clip: 'kabuto_end', loops: 1 },
      ],
      after: 'idle',
    },
  },
};

// 明日方舟干员只有 6 段骨骼动画，映射到同一套状态机上（没有的动作就不进权重表）
const SPINE_MIN = {
  initial: 'idle',
  speed: { walk: 58, chase: 115, surisuri: 115 },
  contactRadius: 14,
  choose: { excludePrevious: true, weights: { walking: 30, sitting: 20, sleeping: 15, interacting: 20, chasing: 15 } },
  states: {
    idle: { phases: [{ clip: 'Relax', loops: -1, duration: [4, 9] }], after: 'choose' },
    walking: { phases: [{ clip: 'Move', loops: -1, movement: 'walk', duration: [4, 10] }], after: 'idle' },
    sitting: { phases: [{ clip: 'Sit', loops: 1 }], after: 'idle' },
    sleeping: { phases: [{ clip: 'Sleep', loops: 1 }], after: 'idle' },
    interacting: { phases: [{ clip: 'Interact', loops: 1 }, { clip: 'Default', loops: 1 }], after: 'idle' },
    chasing: { phases: [{ clip: 'Move', loops: -1, movement: 'chase', duration: [8, 8] }], after: 'idle' },
    surisuri: { phases: [{ clip: 'Interact', loops: [1, 2], movement: 'surisuri' }], after: 'idle' },
  },
};

// 明日方舟「动态立绘」：只有 Idle / Interact / Special 三段，且是整幅插画，
// 所以走慢速漂移（不像小人那样大步走），也不坐下睡觉。
const ILLUST = {
  initial: 'idle',
  speed: { walk: 26, chase: 60, surisuri: 60 },
  contactRadius: 16,
  choose: { excludePrevious: true, weights: { walking: 30, interacting: 30, special: 25, chasing: 15 } },
  states: {
    idle: { phases: [{ clip: 'Idle', loops: -1, duration: [6, 14] }], after: 'choose' },
    walking: { phases: [{ clip: 'Idle', loops: -1, movement: 'walk', duration: [5, 9] }], after: 'idle' },
    interacting: { phases: [{ clip: 'Interact', loops: 1 }], after: 'idle' },
    special: { phases: [{ clip: 'Special', loops: 1 }], after: 'idle' },
    chasing: { phases: [{ clip: 'Idle', loops: -1, movement: 'chase', duration: [6, 6] }], after: 'idle' },
    surisuri: { phases: [{ clip: 'Interact', loops: 1, movement: 'surisuri' }], after: 'idle' },
  },
};

export const PROFILES = { seyana: SEYANA, 'spine-min': SPINE_MIN, illust: ILLUST };

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const profile = PROFILES[a.profile];
  if (!profile) { console.error('profile 必须是: ' + Object.keys(PROFILES).join(', ')); process.exit(2); }
  const p = path.resolve(a.pack);
  const pack = JSON.parse(fs.readFileSync(p, 'utf8'));
  const missing = [];
  const check = function (clip) { if (clip && !pack.animations[clip]) missing.push(clip); };
  for (const name of Object.keys(profile.states)) {
    for (const ph of profile.states[name].phases) {
      if (ph.pick) { for (const o of ph.pick) check(o.clip); } else { check(ph.clip); }
    }
  }
  for (const k of Object.keys(profile.choose.weights)) if (!profile.states[k]) missing.push('state:' + k);
  if (missing.length) console.warn('  ! 引用了不存在的 clip/状态: ' + Array.from(new Set(missing)).join(', '));
  pack.behaviors = profile;
  fs.writeFileSync(p, JSON.stringify(pack, null, 2));
  console.log('已写入 behaviors (' + a.profile + ') -> ' + p);
  console.log('  状态 ' + Object.keys(profile.states).length + ' 个 | 权重项 ' + Object.keys(profile.choose.weights).length + ' 个');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
