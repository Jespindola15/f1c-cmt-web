// Prepara Backblaze B2 para el sitio (una sola vez), usando la clave maestra de la cuenta:
//   - crea (o ajusta) el bucket PRIVADO con la regla CORS para el dominio del sitio (descargas por nombre + Range)
//   - crea una clave de aplicación restringida (readFiles + shareFiles, sólo ese bucket y el prefijo f1c/)
//     para poner en Netlify; la clave maestra nunca va a Netlify ni al navegador.
//   B2_KEY_ID=<maestra> B2_APP_KEY=<maestra> node tools/b2-setup.mjs <bucket> https://TU-SITIO.netlify.app [otro origen…]
import { b2Login } from './b2-lib.mjs';
const [BUCKET, ...ORIGINS] = process.argv.slice(2); const PREFIX = process.env.B2_PREFIX || 'f1c/';
if (!BUCKET || !ORIGINS.length) { console.error('uso: node tools/b2-setup.mjs <bucket> <https://sitio.netlify.app> [más orígenes]'); process.exit(1); }
for (const o of ORIGINS) if (!/^https?:\/\/[^/]+$/.test(o)) { console.error(`origen inválido "${o}" (sin barra final, p.ej. https://mi-sitio.netlify.app)`); process.exit(1); }
const b2 = await b2Login();
const corsRules = [{ corsRuleName: 'f1cSite', allowedOrigins: ORIGINS, allowedOperations: ['b2_download_file_by_name'], allowedHeaders: ['range'], exposeHeaders: ['content-length', 'content-range'], maxAgeSeconds: 86400 }];
let bucket = (await b2.call('b2_list_buckets', { accountId: b2.accountId, bucketName: BUCKET })).buckets[0];
if (!bucket) { bucket = await b2.call('b2_create_bucket', { accountId: b2.accountId, bucketName: BUCKET, bucketType: 'allPrivate', corsRules }); console.log(`bucket ${BUCKET} creado (privado)`); }
else { bucket = await b2.call('b2_update_bucket', { accountId: b2.accountId, bucketId: bucket.bucketId, bucketType: 'allPrivate', corsRules }); console.log(`bucket ${BUCKET} existente: privado y con CORS actualizado`); }
console.log(`CORS: descargas por nombre (con Range) permitidas sólo desde ${ORIGINS.join(', ')}`);
const k = await b2.call('b2_create_key', { accountId: b2.accountId, capabilities: ['readFiles', 'shareFiles'], keyName: 'f1c-netlify-' + Date.now().toString(36), bucketId: bucket.bucketId, namePrefix: PREFIX }, 'v2');
console.log(`\nClave restringida creada (sólo lectura y tokens de descarga, bucket ${BUCKET}, prefijo ${PREFIX}).`);
console.log('Cargá estas variables en Netlify → Site configuration → Environment variables (y volvé a desplegar):\n');
console.log(`  B2_KEY_ID   = ${k.applicationKeyId}\n  B2_APP_KEY  = ${k.applicationKey}\n  B2_BUCKET   = ${BUCKET}\n  ACCESS_KEYS = <claves de tus usuarios, separadas por comas>`);
console.log('\nGuardá B2_APP_KEY ahora: Backblaze no la vuelve a mostrar.');
