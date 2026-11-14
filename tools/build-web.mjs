// Compila el sitio estático para Cloudflare Pages (o cualquier hosting HTTPS) en dist/:
//   node tools/build-web.mjs
// Sólo infraestructura (HTML/JS/WASM del emulador). NO incluye archivos de EA ni de CMT: cada jugador importa su
// propia instalación desde el navegador (OPFS). Opcional: config.json con {"contentBase": "https://…/"} si el
// operador tiene autorización para servir los archivos (p.ej. un bucket R2), en cuyo caso se descargan bajo demanda.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))); const OUT = path.join(ROOT, 'dist');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const copyDir = (from, to, filter = () => true) => { fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) { const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, filter); else if (filter(e.name)) fs.copyFileSync(a, b); } };
copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'), (n) => n.endsWith('.js'));
copyDir(path.join(ROOT, 'web'), path.join(OUT, 'web'), (n) => /\.(js|html|css)$/.test(n) && n !== 'replay.html' && n !== 'replay.js');
fs.copyFileSync(path.join(ROOT, 'web', 'index.html'), path.join(OUT, 'index.html'));
// Encabezados: aislamiento entre orígenes (COOP/COEP) para WebAssembly avanzado/SharedArrayBuffer y caché
fs.writeFileSync(path.join(OUT, '_headers'), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
/src/*
  Cache-Control: public, max-age=3600
/web/*
  Cache-Control: public, max-age=3600
`);
if (process.env.CONTENT_BASE) fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify({ contentBase: process.env.CONTENT_BASE }));
let n = 0, b = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; b += fs.statSync(p).size; } } }; walk(OUT);
console.log(`dist/: ${n} archivos, ${(b / 1024).toFixed(0)} KB (sin archivos del juego)`);
