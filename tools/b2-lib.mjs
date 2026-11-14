// Cliente mínimo de la API nativa de Backblaze B2 (sin dependencias) para las herramientas de administración.
export async function b2Login(keyId = process.env.B2_KEY_ID, appKey = process.env.B2_APP_KEY, api = process.env.B2_API_URL || 'https://api.backblazeb2.com') {
  if (!keyId || !appKey) throw new Error('Faltan B2_KEY_ID y B2_APP_KEY (Backblaze → Application Keys)');
  const r = await fetch(`${api}/b2api/v3/b2_authorize_account`, { headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${appKey}`).toString('base64') } });
  if (!r.ok) throw new Error(`b2_authorize_account HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json(); const s = j.apiInfo.storageApi;
  const call = async (name, body, ver = 'v3') => { const x = await fetch(`${s.apiUrl}/b2api/${ver}/${name}`, { method: 'POST', headers: { Authorization: j.authorizationToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const t = await x.text(); if (!x.ok) { const e = new Error(`${name} HTTP ${x.status}: ${t}`); e.status = x.status; throw e; } return JSON.parse(t); };
  return { accountId: j.accountId, apiUrl: s.apiUrl, downloadUrl: s.downloadUrl, allowed: s.allowed, call };
}
export const b2Name = (n) => encodeURIComponent(n).replace(/%2F/g, '/');
