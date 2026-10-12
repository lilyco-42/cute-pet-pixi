// 测试用的极简静态服务器（模拟 GitHub Release 下载源）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] || 8799);
http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split('?')[0]);
  const p = path.resolve(path.join(root, rel));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log('serving ' + root + ' on ' + port));
