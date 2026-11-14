// Origen de contenido de PRUEBA (HTTPS directo en otro origen, con CORS): manifest.json de una carpeta y
// files/<ruta> leídos de la instalación local (solo lectura). Registra cada descarga.
//   node tools/content-server.mjs <carpeta del manifiesto> <carpeta del juego> [puerto=8900]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [MAN, GAME, PORT = '8900'] = process.argv.slice(2); let served = 0, bytes = 0;
const H = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = null;
  if (u === '/manifest.json') f = path.join(MAN, 'manifest.json');
  else if (u.startsWith('/files/')) { f = path.join(GAME, ...u.slice(7).split('/')); if (!f.startsWith(path.resolve(GAME))) f = null; }
  if (!f || !fs.existsSync(f)) { res.writeHead(404, H); return res.end(); }
  const st = fs.statSync(f); served++; bytes += st.size;
  if (u !== '/manifest.json' && process.env.LOGNET) console.log(`[contenido] ${u} ${st.size}`);
  res.writeHead(200, { ...H, 'Content-Length': st.size, 'Content-Type': 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(Number(PORT), () => console.log(`contenido de prueba en http://localhost:${PORT}/`));
process.on('SIGTERM', () => { console.log(`[contenido] servidos ${served} archivos, ${(bytes / 1048576).toFixed(0)} MB`); process.exit(0); });
