#!/usr/bin/env node
// 检查 APK 的二进制 AndroidManifest.xml 是否声明了某个权限。
//
// 为什么要专门写这个：APK 里的 AndroidManifest.xml 是**二进制 XML**，
// 且字符串池是 **UTF-16LE**，还被 DEFLATE 压缩过。所以
//     unzip -p app.apk AndroidManifest.xml | strings | grep INTERNET
// 永远匹配不到 —— CI 上一度因此误报「缺 INTERNET 权限」（其实有）。
//
//   node apk_has_permission.mjs <apk> <permission>
//   退出码 0 = 有，1 = 没有
import fs from 'fs';
import zlib from 'zlib';

const [apk, want] = process.argv.slice(2);
if (!apk || !want) { console.error('用法: apk_has_permission.mjs <apk> <permission>'); process.exit(2); }

const b = fs.readFileSync(apk);
const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
let off = 0;
let data = null;
while ((off = b.indexOf(sig, off)) !== -1) {
  const method = b.readUInt16LE(off + 10);
  const csize = b.readUInt32LE(off + 20);
  const nameLen = b.readUInt16LE(off + 28);
  const extraLen = b.readUInt16LE(off + 30);
  const cmtLen = b.readUInt16LE(off + 32);
  const lho = b.readUInt32LE(off + 42);
  const name = b.toString('utf8', off + 46, off + 46 + nameLen);
  if (name === 'AndroidManifest.xml') {
    const lnameLen = b.readUInt16LE(lho + 26);
    const lextraLen = b.readUInt16LE(lho + 28);
    const start = lho + 30 + lnameLen + lextraLen;
    let raw = b.subarray(start, start + csize);
    if (method === 8) raw = zlib.inflateRawSync(raw);
    data = raw;
    break;
  }
  off += 46 + nameLen + extraLen + cmtLen;
}
if (!data) { console.error('APK 里没有 AndroidManifest.xml'); process.exit(2); }

// 字符串池是 UTF-16LE；同时也用 UTF-8 扫一遍以兼容非二进制 manifest。
const hit = data.toString('utf16le').includes(want) || data.toString('utf8').includes(want);
process.exit(hit ? 0 : 1);