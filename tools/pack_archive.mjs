#!/usr/bin/env node
// 把一个资产包打成「带素材源前缀」的 tar.gz，并更新 packs-index.json。
//
// 命名约定： <prefix>-<slug>-<version>.tar.gz
//   prefix = 素材来源标识，用来分辨素材（运行时也按它分组）
//     arknights  = 明日方舟（Spine 3.8，鹰角网络）
//     yuzusoft   = 柚子社 Ethornell 分层立绘
//     nctype     = nctype/DesktopSeyana
//     aic        = Alice in Cradle / PixelLiner (laic)
//     original   = 项目自绘
//   运行时解压到 assets/packs/<prefix>-<slug>/，所以不同来源同名也不会撞。
//
// 用法：
//   node tools/pack_archive.mjs --pack assets/packs/amiya --slug amiya --ver 0.2.0 --out dist-packs --base-url <release 下载前缀>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// pack.source.kind -> 素材源前缀
const PREFIX_BY_KIND = {
  spine: 'arknights',
  ethornell: 'yuzusoft',
  desktopseyana: 'nctype',
  laic: 'aic',
  generated: 'original',
  frames: 'original',
};

const LICENSE_BY_KIND = {
  spine: '角色素材版权归鹰角网络；Spine Runtimes 需持有 Spine 授权。仅供个人学习，不得商用分发。',
  ethornell: '角色素材版权归柚子社（《千恋＊万花》）。仅供个人学习，不得商用分发。',
  desktopseyana: '素材来自 nctype/DesktopSeyana（该仓库未声明 LICENSE）。版权归原作者。',
  laic: '素材来自 Alice in Cradle（PixelLiner）。版权归原作者。',
  generated: '项目自绘，随本仓库许可分发。',
};

const BLOCK = 512;

function tarHeader(name, size) {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644', 100, 7); b.write('\u0000', 107, 1);
  b.write('0000000', 108, 7); b.write('\u0000', 115, 1);
  b.write('0000000', 116, 7); b.write('\u0000', 123, 1);
  b.write(size.toString(8).padStart(11, '0'), 124, 11); b.write('\u0000', 135, 1);
  b.write('00000000000', 136, 11); b.write('\u0000', 147, 1);
  b.write('        ', 148, 8);
  b.write('0', 156, 1);
  b.write('ustar', 257, 5); b.write('\u0000', 262, 1);
  b.write('00', 263, 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0'), 148, 6);
  b.write('\u0000', 154, 1);
  b.write(' ', 155, 1);
  return b;
}

function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, r, out);
    else out.push({ name: r, full, size: st.size });
  }
}

export function makeTarGz(packDir) {
  const files = [];
  walk(packDir, '', files);
  const chunks = [];
  for (const f of files) {
    if (Buffer.byteLength(f.name) > 99) throw new Error('路径超过 99 字节，需要 ustar prefix 支持: ' + f.name);
    chunks.push(tarHeader(f.name, f.size));
    const data = fs.readFileSync(f.full);
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return { gz: zlib.gzipSync(Buffer.concat(chunks), { level: 9 }), files: files.length };
}

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
  if (!a.pack || !a.out) { console.error('用法: node tools/pack_archive.mjs --pack <packdir> [--slug <名>] [--ver <版本>] --out <目录> [--base-url <前缀>] [--index <json>]'); process.exit(2); }
  const packDir = path.resolve(a.pack);
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const kind = (pack.source && pack.source.kind) || 'frames';
  const prefix = a.prefix || PREFIX_BY_KIND[kind] || 'other';
  const slug = a.slug || path.basename(packDir);
  const id = prefix + '-' + slug;
  const ver = a.ver || '0.0.0';
  const fileName = id + '-' + ver + '.tar.gz';
  const outDir = path.resolve(a.out);
  fs.mkdirSync(outDir, { recursive: true });
  const { gz, files } = makeTarGz(packDir);
  const dest = path.join(outDir, fileName);
  fs.writeFileSync(dest, gz);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  const base = a['base-url'] || '';
  const url = base ? base.replace(/\/$/, '') + '/' + fileName : fileName;
  const entry = {
    id,
    prefix,
    name: (pack.source && (pack.source.nameCn || pack.source.character)) || pack.id || slug,
    kind,
    version: ver,
    file: fileName,
    url,
    bytes: gz.length,
    sha256,
    files,
    canvas: pack.canvas,
    format: pack.format,
    animations: Object.keys(pack.animations || {}).length,
    behaviors: !!pack.behaviors,
    license: LICENSE_BY_KIND[kind] || '未知，请自行确认授权',
  };
  const indexPath = path.resolve(a.index || path.join(outDir, 'packs-index.json'));
  let index = { version: 1, packs: [] };
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e) { /* 重建 */ }
  }
  index.packs = (index.packs || []).filter((p) => p.id !== id);
  index.packs.push(entry);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log('归档 ' + fileName + '  ' + (gz.length / 1048576).toFixed(2) + ' MB  (' + files + ' 个文件)');
  console.log('  id=' + id + '  prefix=' + prefix + '  sha256=' + sha256.slice(0, 16) + '...');
  console.log('  索引 -> ' + indexPath + '  (共 ' + index.packs.length + ' 个包)');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
