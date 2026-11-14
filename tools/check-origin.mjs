// Verifica el sitio publicado tal como lo usa un usuario: encabezados COOP/COEP, config.json, la función
// /api/content-token (rechaza sin clave, entrega token con clave), CORS de Backblaze B2 para el dominio del sitio,
// rechazo sin token, rangos, y tamaño + SHA-256 de una muestra de archivos (o de todo el grupo de arranque con --boot).
//   node tools/check-origin.mjs https://TU-SITIO.netlify.app <clave> [--boot]
import crypto from 'node:crypto';
const [SITE0, KEY = '', ...rest] = process.argv.slice(2); const SITE = SITE0.replace(/\/$/, ''); const ALL = rest.includes('--boot');
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'OK   ' : 'FALLA'} ${m}`); if (!c) fails++; return c; };
const home = await fetch(SITE + '/'); ok(home.headers.get('cross-origin-embedder-policy') === 'require-corp' && home.headers.get('cross-origin-opener-policy') === 'same-origin', `sitio HTTP ${home.status}, COOP=${home.headers.get('cross-origin-opener-policy')} COEP=${home.headers.get('cross-origin-embedder-policy')}`);
const cfgR = await fetch(SITE + '/config.json'); const cfg = cfgR.ok ? await cfgR.json() : {};
if (!ok(!!cfg.contentToken, `config.json ${cfgR.status} ${JSON.stringify(cfg)} (debe tener contentToken; si da 404 falta B2_BUCKET en Netlify o el redeploy)`)) process.exit(1);
const TU = new URL(cfg.contentToken, SITE + '/').href;
const nk = await fetch(TU); ok(nk.status === 401 || nk.status === 503, `token sin clave -> HTTP ${nk.status} ${(await nk.text()).slice(0, 120)}`);
const tr = await fetch(TU, { headers: { 'X-F1C-Key': KEY } }); const tj = await tr.json().catch(() => ({}));
if (!ok(tr.ok && tj.token, `token con clave -> HTTP ${tr.status} ${tr.ok ? `base ${tj.base}, vence ${new Date(tj.expires).toISOString()}` : JSON.stringify(tj)}`)) process.exit(1);
const base = tj.base.endsWith('/') ? tj.base : tj.base + '/'; const url = (rel) => base + rel + '?Authorization=' + encodeURIComponent(tj.token);
const fu = (p) => url('files/' + p.split('\\').map(encodeURIComponent).join('/'));
const H = { Origin: SITE };
const man0 = await fetch(base + 'manifest.json', { headers: H }); ok(man0.status === 401 || man0.status === 403, `manifest.json sin token -> HTTP ${man0.status} (el bucket debe ser privado)`);
const mr = await fetch(url('manifest.json'), { headers: H }); if (!ok(mr.ok, `manifest.json con token HTTP ${mr.status}`)) process.exit(1);
ok(mr.headers.get('access-control-allow-origin') === SITE, `Access-Control-Allow-Origin = ${mr.headers.get('access-control-allow-origin')} (debe ser ${SITE})`);
const man = await mr.json(); ok(man.format === 'f1c-cmt-web/1', `manifiesto ${man.version}: ${man.files.length} archivos, ${(man.bytes / 1073741824).toFixed(2)} GB, arranque ${(man.bootBytes / 1048576).toFixed(0)} MB`);
const big = [...man.files].sort((a, b) => b.s - a.s)[0];
const pre = await fetch(fu(big.p), { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } });
ok(pre.ok && pre.headers.get('access-control-allow-origin') === SITE, `preflight CORS con Range -> HTTP ${pre.status}, allow-origin=${pre.headers.get('access-control-allow-origin')} allow-headers=${pre.headers.get('access-control-allow-headers')}`);
const rr = await fetch(fu(big.p), { headers: { ...H, Range: 'bytes=1000-1999' } }); const rb = Buffer.from(await rr.arrayBuffer());
ok(rr.status === 206 && rb.length === 1000, `descarga parcial (Range) de ${big.p} -> HTTP ${rr.status}, ${rb.length} bytes, ${rr.headers.get('content-range')}`);
const bad = await fetch(url('manifest.json').replace(/Authorization=[^&]+/, 'Authorization=token-falso'), { headers: H }); ok(bad.status === 401 || bad.status === 403, `token falso -> HTTP ${bad.status}`);
const sample = ALL ? man.files.filter((f) => f.g === 'boot') : [man.files.find((f) => /F1C_CMT\.exe$/i.test(f.p)), ...man.files.filter((_, i) => i % 400 === 0)].filter(Boolean);
let n = 0, i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < sample.length) { const f = sample[i++]; const x = await fetch(fu(f.p), { headers: H }); const b = x.ok ? Buffer.from(await x.arrayBuffer()) : null;
  if (b && b.length === f.s && crypto.createHash('sha256').update(b).digest('hex') === f.h) n++; else ok(false, `${f.p}: HTTP ${x.status} ${b ? b.length + ' bytes' : ''}`); } }));
ok(n === sample.length, `${n}/${sample.length} archivos con tamaño y SHA-256 correctos`);
console.log(fails ? `${fails} problema(s)` : 'Todo listo: el sitio puede cargar el juego automáticamente para usuarios con clave.'); process.exit(fails ? 1 : 0);
