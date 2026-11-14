// Verifica un origen de contenido tal como lo usará el sitio: manifiesto, CORS para el dominio del sitio, clave,
// y una muestra de archivos (tamaño y SHA-256), incluidos todos los del grupo de arranque si se pide --boot.
//   node tools/check-origin.mjs <base, p.ej. https://f1c-content.x.workers.dev/> <origen del sitio> [clave] [--boot]
import crypto from 'node:crypto';
const [BASE0, SITE, KEY = '', ...rest] = process.argv.slice(2); const BASE = BASE0.endsWith('/') ? BASE0 : BASE0 + '/'; const ALL = rest.includes('--boot') || KEY === '--boot';
const key = KEY === '--boot' ? '' : KEY; const H = { Origin: SITE, ...(key ? { 'X-F1C-Key': key } : {}) };
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'OK   ' : 'FALLA'} ${m}`); if (!c) fails++; };
const pre = await fetch(BASE + 'manifest.json', { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-f1c-key' } }).catch((e) => ({ ok: false, status: e.message, headers: new Headers() }));
ok(pre.status === 204 || pre.status === 200, `preflight CORS (${pre.status}) allow-origin=${pre.headers.get('access-control-allow-origin')} allow-headers=${pre.headers.get('access-control-allow-headers')}`);
const r = await fetch(BASE + 'manifest.json', { headers: H });
ok(r.ok, `manifest.json HTTP ${r.status}`); if (!r.ok) process.exit(1);
const aco = r.headers.get('access-control-allow-origin'); ok(aco === SITE || aco === '*', `Access-Control-Allow-Origin = ${aco} (sitio ${SITE})`);
const man = await r.json(); ok(man.format === 'f1c-cmt-web/1', `formato ${man.format}, versión ${man.version}, ${man.files.length} archivos, ${(man.bytes / 1073741824).toFixed(2)} GB, arranque ${(man.bootBytes / 1048576).toFixed(0)} MB`);
if (key) { const nr = await fetch(BASE + 'manifest.json', { headers: { Origin: SITE } }); ok(nr.status === 401, `sin clave -> HTTP ${nr.status} (debe ser 401)`); }
const sample = ALL ? man.files.filter((f) => f.g === 'boot') : [man.files.find((f) => /F1C_CMT\.exe$/i.test(f.p)), ...man.files.filter((_, i) => i % 400 === 0)].filter(Boolean);
let n = 0; for (const f of sample) { const u = BASE + 'files/' + f.p.split('\\').map(encodeURIComponent).join('/'); const x = await fetch(u, { headers: H }); const b = x.ok ? Buffer.from(await x.arrayBuffer()) : null;
  const good = b && b.length === f.s && crypto.createHash('sha256').update(b).digest('hex') === f.h; if (!good) ok(false, `${f.p}: HTTP ${x.status} ${b ? b.length + ' bytes' : ''}`); else n++; }
ok(n === sample.length, `${n}/${sample.length} archivos con tamaño y SHA-256 correctos`);
console.log(fails ? `${fails} problema(s)` : 'Origen listo para el sitio.'); process.exit(fails ? 1 : 0);
