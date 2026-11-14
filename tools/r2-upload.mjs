// Sube el contenido preparado por make-content.mjs a Cloudflare R2 (API S3, firma SigV4, sin dependencias).
// Sólo con autorización para distribuir los archivos. Omite los que ya están (mismo SHA-256 en los metadatos).
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node tools/r2-upload.mjs <carpeta del juego> <manifest.json> <bucket> [prefijo=f1c]
// (sube manifest.json y files/<ruta> leyendo directamente de la instalación; no hace falta la copia --copy)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [GAME, MAN, BUCKET, PREFIX = 'f1c'] = process.argv.slice(2);
const { R2_ACCOUNT_ID: ACC, R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: SK } = process.env;
if (!ACC || !AK || !SK || !BUCKET) { console.error('Faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY o el bucket'); process.exit(1); }
const HOST = `${ACC}.r2.cloudflarestorage.com`;
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest(); const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
async function s3(method, key, body = null, extra = {}) {
  const now = new Date(); const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = amzDate.slice(0, 8);
  const uri = '/' + BUCKET + '/' + key.split('/').map(enc).join('/');
  const headers = { host: HOST, 'x-amz-date': amzDate, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...extra };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canon = [method, uri, '', ...names.map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)]).trim()}`), '', names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/auto/s3/aws4_request`; const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canon)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + SK, day), 'auto'), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(kSig, sts).toString('hex')}`;
  return fetch(`https://${HOST}${uri}`, { method, headers, body });
}
const man = JSON.parse(fs.readFileSync(MAN, 'utf8')); let up = 0, skip = 0, bytes = 0, i = 0; const t0 = Date.now();
async function one(f) {
  const key = `${PREFIX}/files/${f.p.replace(/\\/g, '/')}`;
  const head = await s3('HEAD', key); if (head.ok && head.headers.get('x-amz-meta-sha256') === f.h) { skip++; return; }
  const data = fs.readFileSync(path.join(GAME, ...f.p.split('\\'))); if (sha(data) !== f.h) throw new Error(`${f.p}: el archivo local no coincide con el manifiesto`);
  for (let a = 0; a < 3; a++) { const r = await s3('PUT', key, data, { 'content-type': 'application/octet-stream', 'x-amz-meta-sha256': f.h }); if (r.ok) { up++; bytes += data.length; return; } if (a === 2) throw new Error(`${f.p}: HTTP ${r.status} ${await r.text()}`); }
}
await Promise.all(Array.from({ length: 8 }, async () => { while (i < man.files.length) { const f = man.files[i++]; await one(f); if ((up + skip) % 100 === 0) console.log(`${up + skip}/${man.files.length} · subidos ${up} (${(bytes / 1048576).toFixed(0)} MB) · ya estaban ${skip}`); } }));
const r = await s3('PUT', `${PREFIX}/manifest.json`, JSON.stringify(man), { 'content-type': 'application/json' }); if (!r.ok) throw new Error('manifest: HTTP ' + r.status);
console.log(`listo: ${up} subidos (${(bytes / 1073741824).toFixed(2)} GB), ${skip} ya estaban, en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
