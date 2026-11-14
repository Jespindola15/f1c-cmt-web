// Worker de Cloudflare delante de un bucket R2 privado: sirve el contenido del juego SOLO a usuarios autorizados.
//   GET /manifest.json            GET /files/<ruta>
// Autorización: encabezado `X-F1C-Key: <clave>` (o `?key=`). Claves válidas en el secreto ACCESS_KEYS (separadas por coma).
// CORS: sólo para los orígenes de ALLOWED_ORIGINS (p.ej. https://tu-sitio.netlify.app). Soporta Range y caché HTTP.
export default {
  async fetch(req, env) {
    const url = new URL(req.url); const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = { 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || 'null', 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'X-F1C-Key, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Length, ETag',
      'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('método no permitido', { status: 405, headers: cors });
    if (origin && allowed.length && !allowed.includes(origin)) return new Response('origen no autorizado', { status: 403, headers: cors });
    const keys = (env.ACCESS_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const key = req.headers.get('X-F1C-Key') || url.searchParams.get('key') || '';
    if (keys.length && !keys.includes(key)) return new Response('clave de acceso inválida', { status: 401, headers: cors });
    let k = decodeURIComponent(url.pathname.replace(/^\/+/, '')); if (env.PREFIX) k = env.PREFIX.replace(/\/?$/, '/') + k;
    if (!k || k.includes('..')) return new Response('ruta inválida', { status: 400, headers: cors });
    const obj = await env.CONTENT.get(k, { range: req.headers });
    if (!obj) return new Response('no existe', { status: 404, headers: cors });
    const h = new Headers(cors); obj.writeHttpMetadata(h); h.set('ETag', obj.httpEtag);
    h.set('Cache-Control', k.endsWith('manifest.json') ? 'no-cache' : 'private, max-age=31536000, immutable');
    if (obj.range) { h.set('Content-Range', `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`); return new Response(req.method === 'HEAD' ? null : obj.body, { status: 206, headers: h }); }
    h.set('Content-Length', String(obj.size));
    return new Response(req.method === 'HEAD' ? null : obj.body, { headers: h });
  },
};
