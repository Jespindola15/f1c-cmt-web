// Función de Netlify: GET /api/content-token
// Valida la clave del usuario (encabezado X-F1C-Key contra ACCESS_KEYS) y devuelve un token de descarga de
// Backblaze B2 de SÓLO LECTURA, limitado al prefijo del contenido y con vencimiento:
//   { base: "https://f00x.backblazeb2.com/file/<bucket>/<prefijo>", token, expires }
// El navegador descarga directo de B2 con ?Authorization=<token>. Las claves de B2 quedan sólo en Netlify.
// Variables de entorno (Netlify → Site configuration → Environment variables):
//   B2_KEY_ID, B2_APP_KEY  clave de aplicación de B2 restringida al bucket (readFiles + shareFiles)
//   B2_BUCKET              nombre del bucket privado
//   B2_PREFIX              prefijo del contenido (por defecto "f1c/")
//   ACCESS_KEYS            claves de acceso de los usuarios, separadas por comas (o ACCESS_OPEN=1 para no pedir clave)
//   TOKEN_SECONDS          validez del token de descarga (por defecto 21600 = 6 h; máximo de B2: 604800)
import crypto from 'node:crypto';
const env = (k, d = '') => (process.env[k] ?? d).trim();
const API = () => env('B2_API_URL', 'https://api.backblazeb2.com');
let acct = null, dl = null;

async function authorize() {
  if (acct && Date.now() < acct.until) return acct;
  const basic = Buffer.from(`${env('B2_KEY_ID')}:${env('B2_APP_KEY')}`).toString('base64');
  const r = await fetch(`${API()}/b2api/v3/b2_authorize_account`, { headers: { Authorization: 'Basic ' + basic } });
  if (!r.ok) throw new Error(`b2_authorize_account HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json(); const s = j.apiInfo?.storageApi || {}; const bucket = env('B2_BUCKET');
  let id = (s.allowed?.buckets || []).find((b) => b.name === bucket)?.id;
  if (!id) {                                         // clave no restringida a un bucket: buscarlo por nombre
    const lr = await fetch(`${s.apiUrl}/b2api/v3/b2_list_buckets`, { method: 'POST', headers: { Authorization: j.authorizationToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: j.accountId, bucketName: bucket }) });
    if (!lr.ok) throw new Error(`b2_list_buckets HTTP ${lr.status}: ${await lr.text()}`);
    id = (await lr.json()).buckets?.[0]?.bucketId; if (!id) throw new Error(`no existe el bucket ${bucket} (o la clave no tiene acceso)`);
  }
  acct = { token: j.authorizationToken, apiUrl: s.apiUrl, downloadUrl: s.downloadUrl, bucketId: id, until: Date.now() + 20 * 3600e3 };
  return acct;
}
async function downloadToken() {
  const secs = Math.min(604800, Math.max(600, Number(env('TOKEN_SECONDS', '21600')) || 21600));
  if (dl && dl.expires - Date.now() > (secs * 1000) / 2) return dl;          // reutilizar mientras la función siga activa
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await authorize();
    const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_download_authorization`, { method: 'POST', headers: { Authorization: a.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketId: a.bucketId, fileNamePrefix: env('B2_PREFIX', 'f1c/'), validDurationInSeconds: secs }) });
    if (r.status === 401 && attempt === 0) { acct = null; continue; }      // token de cuenta vencido: reautorizar
    if (!r.ok) throw new Error(`b2_get_download_authorization HTTP ${r.status}: ${await r.text()}`);
    dl = { token: (await r.json()).authorizationToken, expires: Date.now() + secs * 1000 - 60e3 };
    return dl;
  }
}
const digest = (s) => crypto.createHash('sha256').update(s).digest();
const keyOk = (k) => { const d = digest(k); return env('ACCESS_KEYS').split(',').map((x) => x.trim()).filter(Boolean).some((x) => crypto.timingSafeEqual(digest(x), d)); };
const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'GET') return out(405, { error: 'Sólo GET' });
  if (env('ACCESS_OPEN') !== '1') {
    if (!env('ACCESS_KEYS')) return out(503, { error: 'El sitio todavía no tiene claves de acceso configuradas (ACCESS_KEYS).' });
    const k = req.headers.get('x-f1c-key') || '';
    if (!k || !keyOk(k)) return out(401, { error: k ? 'La clave de acceso no es válida.' : 'Hace falta una clave de acceso.' });
  }
  if (!env('B2_KEY_ID') || !env('B2_APP_KEY') || !env('B2_BUCKET')) return out(503, { error: 'Falta configurar B2_KEY_ID, B2_APP_KEY o B2_BUCKET en Netlify.' });
  try {
    const a = await authorize(); const t = await downloadToken();
    const prefix = env('B2_PREFIX', 'f1c/'); const base = `${a.downloadUrl}/file/${encodeURIComponent(env('B2_BUCKET'))}/${prefix.split('/').map(encodeURIComponent).join('/')}`;
    return out(200, { base, token: t.token, expires: t.expires });
  } catch (e) { console.error(e); return out(502, { error: 'No se pudo obtener el permiso de descarga de Backblaze B2.' }); }
};
export const config = { path: '/api/content-token' };
