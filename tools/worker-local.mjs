// Ejecuta cloudflare/content-worker.js en Node con un "R2" simulado (manifiesto + instalación local) para probar
// autorización, CORS y rutas exactamente con el código que se despliega.
//   ACCESS_KEYS=clave1 ALLOWED_ORIGINS=http://localhost:8812 node tools/worker-local.mjs <carpeta manifiesto> <carpeta juego> [puerto=8901]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import worker from '../cloudflare/content-worker.js';
const [MAN, GAME, PORT = '8901'] = process.argv.slice(2); let served = 0, bytes = 0;
const R2 = { async get(k) { let f = null; if (k === 'f1c/manifest.json') f = path.join(MAN, 'manifest.json'); else if (k.startsWith('f1c/files/')) f = path.join(GAME, ...k.slice(10).split('/'));
  if (!f || !fs.existsSync(f)) return null; const data = fs.readFileSync(f); served++; bytes += data.length;
  return { body: data, size: data.length, httpEtag: '"x"', range: null, writeHttpMetadata(h) { h.set('Content-Type', 'application/octet-stream'); } }; } };
const env = { CONTENT: R2, PREFIX: 'f1c', ACCESS_KEYS: process.env.ACCESS_KEYS || '', ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '' };
http.createServer(async (req, res) => {
  const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}).listen(Number(PORT), () => console.log(`worker de contenido local en http://localhost:${PORT}/`));
process.on('SIGTERM', () => { console.log(`[contenido] servidos ${served} archivos, ${(bytes / 1048576).toFixed(0)} MB`); process.exit(0); });
