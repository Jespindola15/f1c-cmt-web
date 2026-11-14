// Sube el contenido a Backblaze B2 (API nativa, sin dependencias) leyendo directamente de la instalación.
// Sólo con autorización para distribuir los archivos. Reanudable: omite lo que ya está con el mismo SHA-256.
//   B2_KEY_ID=… B2_APP_KEY=… node tools/b2-upload.mjs <carpeta del juego> <manifest.json> <bucket> [prefijo=f1c/]
// Usa una clave con writeFiles + listFiles sobre el bucket (la maestra sirve). Sube files/<ruta> y al final manifest.json.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { b2Login, b2Name } from './b2-lib.mjs';
const [GAME, MAN, BUCKET, PREFIX0 = 'f1c/'] = process.argv.slice(2); const PREFIX = PREFIX0.endsWith('/') ? PREFIX0 : PREFIX0 + '/';
if (!GAME || !MAN || !BUCKET) { console.error('uso: node tools/b2-upload.mjs <carpeta del juego> <manifest.json> <bucket> [prefijo]'); process.exit(1); }
const man = JSON.parse(fs.readFileSync(MAN, 'utf8')); const b2 = await b2Login();
const bucket = (b2.allowed?.buckets || []).find((b) => b.name === BUCKET)?.id || (await b2.call('b2_list_buckets', { accountId: b2.accountId, bucketName: BUCKET })).buckets[0]?.bucketId;
if (!bucket) throw new Error(`no existe el bucket ${BUCKET}`);
const have = new Map(); let next = PREFIX;                                     // lo que ya está subido (nombre -> sha256)
do { const r = await b2.call('b2_list_file_names', { bucketId: bucket, prefix: PREFIX, startFileName: next, maxFileCount: 10000 }); for (const f of r.files) have.set(f.fileName, f.fileInfo?.sha256); next = r.nextFileName; } while (next);
const todo = man.files.filter((f) => have.get(`${PREFIX}files/${f.p.replace(/\\/g, '/')}`) !== f.h);
console.log(`${man.files.length} archivos en el manifiesto; ya están ${man.files.length - todo.length}; faltan ${todo.length} (${(todo.reduce((a, f) => a + f.s, 0) / 1073741824).toFixed(2)} GB)`);
async function upload(slot, name, data, sha256, type) {
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');
  for (let a = 0; a < 5; a++) {
    if (!slot.url) Object.assign(slot, await b2.call('b2_get_upload_url', { bucketId: bucket }).then((u) => ({ url: u.uploadUrl, tok: u.authorizationToken })));
    try { const r = await fetch(slot.url, { method: 'POST', headers: { Authorization: slot.tok, 'X-Bz-File-Name': b2Name(name), 'Content-Type': type, 'X-Bz-Content-Sha1': sha1, 'X-Bz-Info-sha256': sha256 }, body: data });
      if (r.ok) return; const t = await r.text(); if (r.status === 400) throw new Error(`${name}: ${t}`); slot.url = null; // 401/408/429/5xx: pedir otra URL
    } catch (e) { if (String(e.message).startsWith(name)) throw e; slot.url = null; }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** a));
  }
  throw new Error(`${name}: no se pudo subir tras 5 intentos`);
}
let i = 0, up = 0, bytes = 0; const t0 = Date.now();
await Promise.all(Array.from({ length: 6 }, async () => { const slot = {};
  while (i < todo.length) { const f = todo[i++]; const data = fs.readFileSync(path.join(GAME, ...f.p.split('\\')));
    if (crypto.createHash('sha256').update(data).digest('hex') !== f.h) throw new Error(`${f.p}: el archivo local no coincide con el manifiesto`);
    await upload(slot, `${PREFIX}files/${f.p.replace(/\\/g, '/')}`, data, f.h, 'application/octet-stream'); up++; bytes += data.length;
    if (up % 50 === 0) console.log(`${up}/${todo.length} · ${(bytes / 1048576).toFixed(0)} MB · ${(bytes / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s`); } }));
const mj = Buffer.from(JSON.stringify(man)); await upload({}, `${PREFIX}manifest.json`, mj, crypto.createHash('sha256').update(mj).digest('hex'), 'application/json');
console.log(`listo: ${up} subidos (${(bytes / 1073741824).toFixed(2)} GB) + manifest.json en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
