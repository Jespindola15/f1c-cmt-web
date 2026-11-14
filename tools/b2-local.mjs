// Backblaze B2 SIMULADO en Node, sólo para pruebas locales (no publica nada): implementa el subconjunto de la API
// nativa que usan el sitio y las herramientas: b2_authorize_account, b2_get_download_authorization, b2_list_buckets,
// b2_create_bucket, b2_update_bucket (reglas CORS), b2_create_key, b2_get_upload_url, b2_upload_file,
// b2_list_file_names y GET /file/<bucket>/<nombre>?Authorization=… (bucket privado, CORS, rangos).
//   node tools/b2-local.mjs <puerto> [--store carpeta] [--mirror <carpeta manifiesto> <carpeta juego>]
//   --mirror sirve f1c/manifest.json y f1c/files/<ruta> directamente desde la instalación (sin copiarla).
//   Entorno: B2_KEY_ID/B2_APP_KEY (credenciales aceptadas, por defecto test/test), B2_BUCKET (f1c-cmt),
//   ALLOWED_ORIGINS (regla CORS inicial), CUT_EVERY=n (corta a la mitad una de cada n respuestas grandes).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const args = process.argv.slice(2); const PORT = Number(args[0] || 8902); const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args.slice(i + 1, i + 3); };
const STORE = opt('--store')?.[0] || null; const MIRROR = opt('--mirror');
const KID = process.env.B2_KEY_ID || 'test', KEY = process.env.B2_APP_KEY || 'test', BUCKET = process.env.B2_BUCKET || 'f1c-cmt', ACC = 'acc0001';
const ORIGIN = `http://localhost:${PORT}`; const CUT = Number(process.env.CUT_EVERY || 0);
const bucket = { bucketId: 'bkt0001', bucketName: BUCKET, bucketType: 'allPrivate', accountId: ACC,
  corsRules: (process.env.ALLOWED_ORIGINS ? [{ corsRuleName: 'test', allowedOrigins: process.env.ALLOWED_ORIGINS.split(','), allowedOperations: ['b2_download_file_by_name'], allowedHeaders: ['range'], maxAgeSeconds: 3600 }] : []) };
const keys = new Map([[KID, { key: KEY, bucketId: null }]]); const acctTokens = new Map(); const dlTokens = new Map(); const upTokens = new Set();
const st = { files: 0, bytes: 0, ranges: 0, cuts: 0, denied: 0, uploads: 0, gets: 0 };
const files = new Map();                                     // subidos: nombre -> {path, size, sha1, info}
if (STORE) { fs.mkdirSync(STORE, { recursive: true }); const ix = path.join(STORE, 'index.json'); if (fs.existsSync(ix)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ix, 'utf8')))) files.set(k, v); }
const saveStore = () => STORE && fs.writeFileSync(path.join(STORE, 'index.json'), JSON.stringify(Object.fromEntries(files)));
const mirrorPath = (name) => { if (!MIRROR) return null; if (name === 'f1c/manifest.json') return path.join(MIRROR[0], 'manifest.json'); if (name.startsWith('f1c/files/')) return path.join(MIRROR[1], ...name.slice(10).split('/')); return null; };
const err = (res, status, code, message, h = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify({ status, code, message })); };
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const tok = (p) => p + crypto.randomBytes(12).toString('hex');
const corsMatch = (origin, hdrs) => bucket.corsRules.find((r) => r.allowedOperations.includes('b2_download_file_by_name') && (r.allowedOrigins.includes('*') || r.allowedOrigins.includes(origin) || (r.allowedOrigins.includes('https') && origin.startsWith('https://'))) && hdrs.every((h) => (r.allowedHeaders || []).map((x) => x.toLowerCase()).includes('*') || (r.allowedHeaders || []).map((x) => x.toLowerCase()).includes(h)));
const api = {
  async b2_get_download_authorization(a, j) { if (j.bucketId !== bucket.bucketId) throw [400, 'bad_request', 'bucketId']; if (a.bucketId && a.bucketId !== j.bucketId) throw [401, 'unauthorized', 'bucket']; const t = tok('3_dl_'); dlTokens.set(t, { prefix: j.fileNamePrefix || '', exp: Date.now() + j.validDurationInSeconds * 1000 }); return { authorizationToken: t, bucketId: j.bucketId, fileNamePrefix: j.fileNamePrefix }; },
  async b2_list_buckets(a, j) { return { buckets: !j.bucketName || j.bucketName === BUCKET ? [bucket] : [] }; },
  async b2_create_bucket(a, j) { if (j.bucketName !== BUCKET) throw [400, 'bad_request', 'sólo existe ' + BUCKET]; Object.assign(bucket, { bucketType: j.bucketType, corsRules: j.corsRules || [] }); return bucket; },
  async b2_update_bucket(a, j) { if (j.bucketType) bucket.bucketType = j.bucketType; if (j.corsRules) bucket.corsRules = j.corsRules; return bucket; },
  async b2_create_key(a, j) { const id = tok('k_'), key = tok('K_'); keys.set(id, { key, bucketId: j.bucketId || j.bucketIds?.[0] || null, caps: j.capabilities, namePrefix: j.namePrefix }); return { applicationKeyId: id, applicationKey: key, capabilities: j.capabilities, bucketId: j.bucketId }; },
  async b2_get_upload_url(a, j) { const t = tok('up_'); upTokens.add(t); return { bucketId: j.bucketId, uploadUrl: `${ORIGIN}/b2api/v3/upload/${j.bucketId}`, authorizationToken: t }; },
  async b2_list_file_names(a, j) { const names = [...files.keys()].filter((n) => n.startsWith(j.prefix || '') && n >= (j.startFileName || '')).sort(); const max = j.maxFileCount || 100; const page = names.slice(0, max);
    return { files: page.map((n) => ({ fileName: n, contentLength: files.get(n).size, contentSha1: files.get(n).sha1, fileInfo: files.get(n).info })), nextFileName: names[max] || null }; },
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, ORIGIN); const origin = req.headers.origin || '';
  try {
    if (u.pathname === '/b2api/v3/b2_authorize_account') {
      const [id, k] = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':'); const e = keys.get(id);
      if (!e || e.key !== k) return err(res, 401, 'unauthorized', 'credenciales inválidas');
      const t = tok('4_acct_'); acctTokens.set(t, e);
      return res.end(JSON.stringify({ accountId: ACC, authorizationToken: t, apiInfo: { storageApi: { apiUrl: ORIGIN, downloadUrl: ORIGIN, s3ApiUrl: ORIGIN, allowed: { buckets: e.bucketId ? [{ id: bucket.bucketId, name: BUCKET }] : null, capabilities: e.caps || ['all'], namePrefix: e.namePrefix || null } } } }));
    }
    if (u.pathname.startsWith('/b2api/v3/upload/')) {
      if (!upTokens.has(req.headers.authorization)) return err(res, 401, 'expired_auth_token', 'upload token');
      const b = await body(req); const name = decodeURIComponent(req.headers['x-bz-file-name']); const sha1 = crypto.createHash('sha1').update(b).digest('hex');
      if (req.headers['x-bz-content-sha1'] !== sha1) return err(res, 400, 'bad_request', 'sha1 distinto');
      const info = {}; for (const [h, v] of Object.entries(req.headers)) if (h.startsWith('x-bz-info-')) info[h.slice(10)] = decodeURIComponent(v);
      const p = path.join(STORE, crypto.createHash('sha1').update(name).digest('hex')); fs.writeFileSync(p, b); files.set(name, { path: p, size: b.length, sha1, info }); saveStore(); st.uploads++;
      return res.end(JSON.stringify({ fileName: name, contentLength: b.length, contentSha1: sha1, fileInfo: info }));
    }
    const m = u.pathname.match(/^\/b2api\/v[234]\/(b2_\w+)$/);
    if (m) { const a = acctTokens.get(req.headers.authorization); if (!a) return err(res, 401, 'expired_auth_token', 'token de cuenta');
      if (!api[m[1]]) return err(res, 400, 'bad_request', 'no simulado: ' + m[1]);
      try { return res.end(JSON.stringify(await api[m[1]](a, JSON.parse((await body(req)).toString() || '{}')))); } catch (x) { if (Array.isArray(x)) return err(res, ...x); throw x; } }
    const f = u.pathname.match(/^\/file\/([^/]+)\/(.+)$/);
    if (f) {
      if (req.method === 'OPTIONS') { const hdrs = (req.headers['access-control-request-headers'] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); const r = corsMatch(origin, hdrs);
        if (!r) { st.denied++; res.writeHead(403); return res.end(); }
        res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': hdrs.join(', '), 'Access-Control-Max-Age': String(r.maxAgeSeconds || 3600), Vary: 'Origin' }); return res.end(); }
      const cors = origin && corsMatch(origin, []) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'content-length, content-range', Vary: 'Origin' } : {};
      if (decodeURIComponent(f[1]) !== BUCKET) return err(res, 404, 'not_found', 'bucket', cors);
      const name = decodeURIComponent(f[2]); const t = dlTokens.get(u.searchParams.get('Authorization') || req.headers.authorization || '');
      if (bucket.bucketType !== 'allPublic' && (!t || t.exp < Date.now() || !name.startsWith(t.prefix))) { st.denied++; return err(res, 401, 'unauthorized', 'hace falta un token de descarga válido', cors); }
      let p = files.get(name)?.path || mirrorPath(name); if (!p || !fs.existsSync(p)) return err(res, 404, 'not_found', name, cors);
      const size = fs.statSync(p).size; let a = 0, z = size - 1, status = 200; const rg = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (rg) { a = Number(rg[1]); z = rg[2] ? Math.min(Number(rg[2]), size - 1) : size - 1; status = 206; st.ranges++; if (a > z) return err(res, 416, 'range_not_satisfiable', 'rango', cors); }
      res.writeHead(status, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(z - a + 1), 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${a}-${z}/${size}` } : {}) });
      st.gets++; const n = z - a + 1;
      if (CUT && n > 1 << 20 && st.gets % CUT === 0) { st.cuts++; const s = fs.createReadStream(p, { start: a, end: a + (n >> 1) - 1 }); s.on('end', () => setTimeout(() => res.destroy(), 50)); return s.pipe(res, { end: false }); }
      st.files++; st.bytes += n; return fs.createReadStream(p, { start: a, end: z }).pipe(res);
    }
    err(res, 404, 'not_found', u.pathname);
  } catch (x) { console.error(x); try { err(res, 500, 'internal', String(x.message)); } catch {} }
}).listen(PORT, () => console.log(`B2 simulado en ${ORIGIN}/ (bucket ${BUCKET}${MIRROR ? ', espejo de la instalación' : ''})`));
const bye = () => { console.log(`[contenido] servidos ${st.files} respuestas, ${(st.bytes / 1048576).toFixed(0)} MB · por rango ${st.ranges} · cortes simulados ${st.cuts} · rechazados ${st.denied} · subidos ${st.uploads}`); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
