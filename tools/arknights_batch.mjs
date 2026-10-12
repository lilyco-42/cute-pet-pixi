#!/usr/bin/env node
// 热门角色素材包批量流水线：下载模型 -> 烘焙成统一资产包 -> 注入行为 -> 打带前缀的 tar.gz -> 更新索引
//   node tools/arknights_batch.mjs --list 002_amiya,003_kalts --scale 0.5 --fps 8 --ver 0.2.0
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RAW_ROOT = 'https://raw.githubusercontent.com/isHarryh/Ark-Models/main/';
const ROOT = path.resolve(path.dirname(process.argv[1]), '..');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a[t.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return a;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'op';
}

async function ensureModel(key, entry, modelsDir, subdir) {
  const dir = path.join(modelsDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (const v of Object.values(entry.assetList || {})) {
    if (Array.isArray(v)) names.push(...v); else names.push(v);
  }
  for (const f of names) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const url = RAW_ROOT + subdir + '/' + encodeURIComponent(key) + '/' + encodeURIComponent(f);
    const res = await fetch(url);
    if (!res.ok) throw new Error('下载失败 ' + f + ' HTTP ' + res.status);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return dir;
}

function run(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(label + ' 失败: ' + (r.stderr || r.stdout || '').slice(-400));
  return (r.stdout || '').trim();
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const index = JSON.parse(fs.readFileSync(path.resolve(a.index || '_ark/models_data.json'), 'utf8'));
  const list = String(a.list || '').split(',').map((s) => s.trim()).filter(Boolean);
  const kind = String(a.kind || 'operator');
  const subdir = kind === 'illust' ? 'models_illust' : 'models';
  const profile = kind === 'illust' ? 'illust' : 'spine-min';
  const scale = String(a.scale || (kind === 'illust' ? 0.12 : 0.5));
  const fps = String(a.fps || 8);
  const ver = String(a.ver || '0.0.0');
  const baseUrl = a['base-url'] || 'https://github.com/lilyco-42/cute-pet/releases/download/packs-' + ver;
  const modelsDir = path.resolve(a.models || 'models');
  const packsIndex = path.resolve(a.packsIndex || 'assets/packs-index.json');
  const results = [];
  for (const key of list) {
    const entry = index.data[key];
    if (!entry) { console.log('跳过 ' + key + '：索引里没有'); continue; }
    const slug = a.slugFrom === 'key' ? slugify(key) : slugify(entry.appellation || entry.name || key);
    const id = 'arknights-' + slug;
    const outDir = path.join(ROOT, 'assets', 'packs', id);
    try {
      console.log('=== ' + key + '  ' + entry.name + '  ->  ' + id + '  (kind=' + kind + ')');
      await ensureModel(key, entry, modelsDir, subdir);
      fs.rmSync(path.join(outDir, 'frames'), { recursive: true, force: true });
      const modelPath = path.join(modelsDir, key);
      // 1) 扫一次共享包围盒（scanBounds 不建大 canvas，很便宜）
      const scan = run(['tools/spine_export.mjs', '--model', modelPath, '--scan-only',
        '--fps', fps, '--scale', scale], 'spine_scan');
      const bm = /BOUNDS (\{.*\})/.exec(scan);
      if (!bm) throw new Error('扫描没拿到 BOUNDS：' + scan.slice(-200));
      const am = /动画 \d+ 个: (.*)$/m.exec(scan);
      const anims = am ? am[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!anims.length) throw new Error('扫描没拿到动画名');
      // 2) 一段动画一个进程：重 mesh 模型跨动画的内存累积会把 cairo 顶爆
      for (const anim of anims) {
        const args = ['tools/spine_export.mjs', '--model', modelPath, '--out', outDir,
          '--anim', anim, '--bounds-json', bm[1], '--merge',
          '--fps', fps, '--scale', scale, '--id', id];
        if (a.recycle) args.push('--recycle', String(a.recycle));
        const line = run(args, 'spine_export(' + anim + ')');
        console.log('  ' + (line.split('\n').filter((l) => l.includes('帧 @')).pop() || line.split('\n').pop()));
      }
      const pj = path.join(outDir, 'pack.json');
      const pack = JSON.parse(fs.readFileSync(pj, 'utf8'));
      pack.source.nameCn = entry.name;
      pack.source.character = entry.appellation;
      pack.source.license = '角色素材版权归鹰角网络；仅供个人学习，不得商用分发';
      fs.writeFileSync(pj, JSON.stringify(pack, null, 2));
      run(['tools/behaviors.mjs', '--pack', pj, '--profile', profile], 'behaviors');
      const line = run(['tools/pack_archive.mjs', '--pack', outDir, '--slug', slug, '--ver', ver, '--out', 'dist-packs', '--base-url', baseUrl, '--index', packsIndex], 'pack_archive');
      results.push({ key, name: entry.name, id, ok: true });
      console.log('  ' + line.split('\n')[0]);
    } catch (err) {
      results.push({ key, name: entry.name, id, ok: false, error: String(err && err.message || err) });
      console.log('  !! 失败: ' + ((err && err.message) || err));
    }
  }
  console.log('\n=== 汇总 ===');
  for (const r of results) console.log((r.ok ? '  OK   ' : '  FAIL ') + (r.id + '        ').slice(0, 30) + r.name + (r.ok ? '' : '  ' + r.error));
  console.log('成功 ' + results.filter((r) => r.ok).length + ' / ' + results.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
