// 生成 build/icon.ico（256x256，PNG 内嵌式 ICO）。
// 刻意用自绘的 chibi 占位图，不拿第三方版权角色当应用图标。
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from 'canvas';

// 参数可省略：默认拿仓库里自绘的 chibi 首帧当源图，输出 build/icon.ico。
// 之前没有默认值，CI 里裸跑 `node tools/make_icon.mjs` 会拿 undefined 去 readFileSync，
// 报 ERR_INVALID_ARG_TYPE 然后整个打包 job 挂掉（已实测）。
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const src = process.argv[2] || path.join(ROOT, 'assets/packs/chibi/frames/idle_00.png');
const out = process.argv[3] || path.join(ROOT, 'build/icon.ico');
const SIZE = 256;
if (!fs.existsSync(src)) { console.error('找不到源图: ' + src); process.exit(1); }
const img = await loadImage(fs.readFileSync(src));
const c = createCanvas(SIZE, SIZE);
const ctx = c.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.clearRect(0, 0, SIZE, SIZE);
ctx.drawImage(img, 0, 0, SIZE, SIZE);
const png = c.toBuffer('image/png');

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // type = icon
header.writeUInt16LE(1, 4);   // count
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);        // width 0 = 256
entry.writeUInt8(0, 1);        // height 0 = 256
entry.writeUInt8(0, 2);        // palette
entry.writeUInt8(0, 3);        // reserved
entry.writeUInt16LE(1, 4);     // planes
entry.writeUInt16LE(32, 6);    // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, entry, png]));
console.log('icon -> ' + out + '  ' + (header.length + entry.length + png.length) + ' bytes');
