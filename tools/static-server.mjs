// Servidor estático mínimo para probar dist/ como en Cloudflare Pages (aplica los encabezados de dist/_headers).
//   node tools/static-server.mjs [dir=dist] [puerto=8800]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const DIR = path.resolve(process.argv[2] || 'dist'); const PORT = Number(process.argv[3] || 8800);
const H = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
http.createServer((req, res) => { let u = decodeURIComponent(req.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html'; const f = path.join(DIR, u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, H); return res.end('404'); }
  res.writeHead(200, { ...H, 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(PORT, () => console.log(`dist en http://localhost:${PORT}/`));
