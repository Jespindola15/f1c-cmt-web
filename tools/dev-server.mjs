// Servidor de desarrollo: sirve la web, el código y la carpeta del juego (SOLO LECTURA) por HTTP.
//   node tools/dev-server.mjs "<carpeta F1 Challenge 2025 CMT>" [puerto] [carpeta de instantáneas]
// /game/manifest.json = lista de archivos y carpetas (la usa el VFS del navegador para "carga automática").
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME = path.resolve(process.argv[2] || '.'); const PORT = Number(process.argv[3] || 8150);
const SNAP = process.argv[4] ? path.resolve(process.argv[4]) : null; // carpeta de instantáneas (opcional): /snap/<nombre>/state.bin|mem.bin
const SKIP = /^(CMTSeasonData\.zip|Audio[\\/]Vehicle\.zip|CMTSeasonData[\\/]Circuits\.zip|SelectDirectXInstaller|Support|DrivingSchool|CMTLOG|Src|Permissions|Shaders|Telemetry)/i;
function manifest() {
  const files = [], dirs = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (SKIP.test(r)) continue;
    if (e.isDirectory()) { dirs.push(r); walk(path.join(d, e.name), r); } else files.push([r, fs.statSync(path.join(d, e.name)).size]); } };
  walk(GAME, ''); return { files, dirs };
}
let man = null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const H = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  try {
    if (url === '/game/manifest.json') { man ??= manifest(); res.writeHead(200, { ...H, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(man)); }
    let file;
    if (url.startsWith('/cap/') && process.env.CAP) { const C = path.resolve(process.env.CAP); file = path.join(C, url.slice(5)); if (!file.startsWith(C)) throw new Error('ruta'); }
    else if (url.startsWith('/snap/') && SNAP) { file = path.join(SNAP, url.slice(6)); if (!file.startsWith(SNAP)) throw new Error('ruta'); }
    else if (url.startsWith('/game/')) { file = path.join(GAME, url.slice(6)); if (!file.startsWith(GAME)) throw new Error('ruta'); }
    else { file = path.join(ROOT, url === '/' ? 'web/index.html' : url); if (!file.startsWith(ROOT)) throw new Error('ruta'); }
    const st = fs.statSync(file); if (!st.isFile()) throw new Error('no es archivo');
    res.writeHead(200, { ...H, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size }); fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(404, H); res.end('404 ' + url); }
}).listen(PORT, () => console.log(`F1C CMT Web en http://localhost:${PORT}/  (juego: ${GAME})`));
