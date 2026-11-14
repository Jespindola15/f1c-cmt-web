// Prepara el contenido para un origen autorizado (Backblaze B2 o cualquier HTTPS): manifiesto con rutas, tamaños,
// SHA-256 y grupo de carga, más (opcional) una copia de los archivos con la estructura que espera el sitio.
//   node tools/make-content.mjs <carpeta del juego> <salida> [--copy] [--boot tools/boot-files.json]
// Salida:  <salida>/manifest.json   y con --copy  <salida>/files/<ruta del juego con />
// Subir a Backblaze B2:  node tools/b2-upload.mjs <juego> <salida>/manifest.json <bucket>   (ver README)
// No usar para publicar sin autorización de EA/CMT.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKIP_RE } from '../src/vfs-core.js';
const args = process.argv.slice(2); const GAME = args[0], OUT = args[1]; const COPY = args.includes('--copy');
const bootFile = args.includes('--boot') ? args[args.indexOf('--boot') + 1] : new URL('./boot-files.json', import.meta.url).pathname;
const boot = new Set(JSON.parse(fs.readFileSync(bootFile, 'utf8')).map((p) => p.toUpperCase()));
// siempre en el arranque: ejecutable, configuración, opciones/menús y partidas guardadas
const ALWAYS = /^(F1C_CMT\.exe|Config\.ini|[^\\/]+\.(dll|ini|cfg)|CMTSave[\\/].*|CMTOptions[\\/][^\\/]+\.(mas|MAS|ini|dic|cur|bmp)$)/i;
const files = [], dirs = []; let bytes = 0, bootBytes = 0;
const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const r = rel ? rel + '\\' + e.name : e.name; if (SKIP_RE.test(r)) continue;
  if (e.isDirectory()) { dirs.push(r); walk(path.join(d, e.name), r); continue; }
  const full = path.join(d, e.name), data = fs.readFileSync(full); const h = crypto.createHash('sha256').update(data).digest('hex');
  const g = boot.has(r.toUpperCase()) || ALWAYS.test(r) ? 'boot' : 'demand';
  files.push({ p: r, s: data.length, h, g }); bytes += data.length; if (g === 'boot') bootBytes += data.length;
  if (COPY) { const dst = path.join(OUT, 'files', ...r.split('\\')); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(full, dst); }
} };
walk(GAME, '');
// versión = hash del listado (cambia si cambia cualquier archivo): separa cachés entre versiones del contenido
const version = crypto.createHash('sha256').update(files.map((f) => f.p + ':' + f.h).join('\n')).digest('hex').slice(0, 16);
const man = { format: 'f1c-cmt-web/1', version, created: new Date().toISOString(), bytes, bootBytes, files, dirs };
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(man));
console.log(`manifiesto ${version}: ${files.length} archivos, ${(bytes / 1073741824).toFixed(2)} GB; arranque ${files.filter((f) => f.g === 'boot').length} archivos, ${(bootBytes / 1048576).toFixed(0)} MB${COPY ? '; copiados en ' + path.join(OUT, 'files') : ''}`);
