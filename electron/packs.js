'use strict';
// 素材按需拉取：从 Release 下载带前缀的 tar.gz，校验后自动解压到 assets/packs/<id>/
//
// 为什么这样做：第三方版权素材不进发布包（合规），用户首次启动时按需拉取。
// 文件名/目录名都带素材源前缀（arknights- / yuzusoft- / nctype- / aic- / original-），
// 所以不同来源的同名素材不会互相覆盖，日志里也能一眼看出这包是谁的。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { net } = require('electron');

const BLOCK = 512;

// 极简 ustar 解压：不引第三方 tar 依赖（发布包里少一个传递依赖就少一处风险）
function extractTarGz(gzBuf, destDir) {
  const buf = zlib.gunzipSync(gzBuf);
  const dest = path.resolve(destDir);
  const written = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) { if (header[i] !== 0) { allZero = false; break; } }
    if (allZero) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\u0000.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\u0000.*$/s, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\u0000.*$/s, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    off += BLOCK;
    if (type === '0' || type === '\u0000' || type === '') {
      const full = path.resolve(path.join(dest, name));
      // 拒绝路径穿越：tar 是外部输入
      if (full !== dest && !full.startsWith(dest + path.sep)) throw new Error('tar 路径越界: ' + name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf.subarray(off, off + size));
      written.push(name);
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return written;
}

async function fetchBuffer(url) {
  if (url.startsWith('file://')) return fs.promises.readFile(new URL(url));
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

function indexCandidates(root) {
  const list = [];
  if (process.env.PET_PACKS_INDEX) list.push(process.env.PET_PACKS_INDEX);
  list.push(path.join(root, 'assets', 'packs-index.json'));
  return list;
}

async function ensurePacks(opts) {
  const root = opts.root;
  const log = opts.log || function () {};
  const indexPath = indexCandidates(root).find((p) => fs.existsSync(p));
  if (!indexPath) { log('没有 packs-index.json，跳过素材拉取'); return { installed: [], skipped: [], failed: [], checked: 0 }; }
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e) { log('索引解析失败: ' + e.message); return { installed: [], skipped: [], failed: [], checked: 0 }; }
  const installed = [];
  const skipped = [];
  const failed = [];
  for (const e of index.packs || []) {
    const dest = path.join(root, 'assets', 'packs', e.id);
    if (fs.existsSync(path.join(dest, 'pack.json'))) { skipped.push(e.id); continue; }
    try {
      log('拉取 ' + e.id + '  (' + (e.bytes / 1048576).toFixed(1) + ' MB, prefix=' + e.prefix + ')');
      const buf = await fetchBuffer(e.url);
      if (e.bytes && buf.length !== e.bytes) throw new Error('大小不符 ' + buf.length + ' != ' + e.bytes);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (e.sha256 && sha !== e.sha256) throw new Error('sha256 不符');
      const files = extractTarGz(buf, dest);
      if (!fs.existsSync(path.join(dest, 'pack.json'))) throw new Error('解压后没有 pack.json');
      installed.push({ id: e.id, files: files.length });
      log('已安装 ' + e.id + ' (' + files.length + ' 个文件)');
    } catch (err) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
      failed.push({ id: e.id, error: String((err && err.message) || err) });
      log('安装失败 ' + e.id + ': ' + ((err && err.message) || err));
    }
  }
  return { installed, skipped, failed, checked: (index.packs || []).length };
}

module.exports = { ensurePacks, extractTarGz };
