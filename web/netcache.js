// netcache.js — archivos del juego desde un origen HTTPS autorizado con caché persistente en OPFS.
// Formato del origen:  <base>manifest.json  y  <base>files/<ruta con />   (ver tools/make-content.mjs)
// Dos modos de origen (ContentOrigin):
//  - directo: una base HTTPS pública con CORS (…/manifest.json, …/files/<ruta>).
//  - token (Backblaze B2 privado): la función del sitio /api/content-token valida la clave del usuario y devuelve
//    {base, token, expires}; las descargas van directo a B2 con ?Authorization=<token> (token de sólo lectura,
//    limitado al prefijo del contenido y con vencimiento). Ninguna clave de B2 llega al navegador.
// Caché (OPFS f1c-net/): data.bin (contenido concatenado) + index.json (hash SHA-256 -> [desplazamiento, tamaño]).
// Indexada por hash: si el manifiesto cambia, sólo se descargan los archivos que cambiaron.
// Descargas por rangos (CHUNK) y reanudables: un archivo a medio bajar queda como [desplazamiento, tamaño, bytes
// recibidos] y continúa desde ahí (tras un corte de red o al volver a abrir la página); se verifica el SHA-256 al final.
import { sha256 } from '../src/sha256.js';
export const CHUNK = 8 << 20;
const enc = (p) => p.split(/[\\/]/).map(encodeURIComponent).join('/');
const json = (t) => { try { return JSON.parse(t); } catch { return {}; } };
const authError = (status, msg) => { const e = new Error('CLAVE: ' + (msg || `HTTP ${status}`)); e.auth = true; return e; };
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export class ContentOrigin {
  constructor(src) { this.src = src; this.base = src.base ? (src.base.endsWith('/') ? src.base : src.base + '/') : ''; this.token = ''; this.expires = Infinity; }
  get tokenMode() { return !!this.src.tokenUrl; }
  apply(j) { this.base = j.base.endsWith('/') ? j.base : j.base + '/'; this.token = j.token || ''; this.expires = j.expires || Infinity; }
  async refresh() {
    if (!this.tokenMode) return;
    const r = await fetch(this.src.tokenUrl, { cache: 'no-store', headers: this.src.key ? { 'X-F1C-Key': this.src.key } : {} });
    if (r.status === 401 || r.status === 403) throw authError(r.status, json(await r.text()).error);
    if (!r.ok) throw new Error(`servidor de acceso: HTTP ${r.status} ${json(await r.text()).error || ''}`);
    this.apply(await r.json());
  }
  refreshSync() {
    if (!this.tokenMode) return;
    const x = new XMLHttpRequest(); x.open('GET', this.src.tokenUrl, false); if (this.src.key) x.setRequestHeader('X-F1C-Key', this.src.key); x.send();
    if (x.status === 401 || x.status === 403) throw authError(x.status, json(x.responseText).error);
    if (x.status !== 200) throw new Error(`servidor de acceso: HTTP ${x.status}`);
    this.apply(JSON.parse(x.responseText));
  }
  stale() { return this.tokenMode && Date.now() > this.expires - 10 * 60e3; }
  url(rel) { const u = this.base + rel; return this.token ? u + '?Authorization=' + encodeURIComponent(this.token) : u; }
  fileUrl(p) { return this.url('files/' + enc(p)); }
}

export class NetCache {
  static async open(origin, onEvent) {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('f1c-net', { create: true });
    const data = await (await root.getFileHandle('data.bin', { create: true })).createSyncAccessHandle();
    const idxH = await (await root.getFileHandle('index.json', { create: true })).createSyncAccessHandle();
    const c = new NetCache(); c.origin = origin; c.data = data; c.idxH = idxH; c.onEvent = onEvent || (() => {});
    let idx = {}; const n = idxH.getSize(); if (n) { const b = new Uint8Array(n); idxH.read(b, { at: 0 }); idx = json(new TextDecoder().decode(b)); }
    c.index = new Map(Object.entries(idx.files || {})); const size = data.getSize(); c.end = size;
    for (const [h, e] of c.index) {
      if (e.length === 2) { if (e[0] + e[1] > size) c.index.delete(h); }           // completo pero cortado al escribir
      else e[2] = Math.max(0, Math.min(e[2], size - e[0]));                         // parcial: sólo lo que llegó al disco
    }
    for (const e of c.index.values()) c.end = Math.max(c.end, e[0] + e[1]);
    c.dirty = false; c.stats = { hits: 0, downloads: 0, bytes: 0, resumed: 0 };
    return c;
  }
  has(h) { const e = this.index.get(h); return !!e && e.length === 2; }
  partialBytes(h) { const e = this.index.get(h); return e && e.length === 3 ? e[2] : 0; }
  saveIndex() { this.data.flush(); const b = new TextEncoder().encode(JSON.stringify({ files: Object.fromEntries(this.index) })); this.idxH.truncate(0); this.idxH.write(b, { at: 0 }); this.idxH.flush(); this.dirty = false; }
  writeAt(off, bytes) { let w = 0; while (w < bytes.length) w += this.data.write(bytes.subarray(w), { at: off + w }); }
  readAt(off, n) { const b = new Uint8Array(n); let r = 0; while (r < n) { const k = this.data.read(b.subarray(r), { at: off + r }); if (k <= 0) break; r += k; } return b; }
  readHash(h) { const e = this.index.get(h); if (!e || e.length !== 2) return null; this.stats.hits++; return this.readAt(e[0], e[1]); }
  // reserva (o retoma) el lugar de un archivo en data.bin
  reserve(entry) {
    let e = this.index.get(entry.h);
    if (!e) { e = [this.end, entry.size, 0]; this.end += entry.size; this.index.set(entry.h, e); }
    else if (e[2] > 0) this.stats.resumed++;
    return e;
  }
  // cierra un archivo completo verificando el SHA-256; si no coincide lo vuelve a 0 bytes
  finish(h, digest) { const e = this.index.get(h); if (digest === h) { this.index.set(h, [e[0], e[1]]); return true; } e[2] = 0; return false; }
  // lectura para el VFS (síncrona): caché o descarga inmediata por rangos, reanudable
  read(entry) {
    const c = this.readHash(entry.h); if (c) return c;
    this.onEvent({ type: 'net', path: entry.path, size: entry.size, phase: 'start' });
    const e = this.reserve(entry); let fails = 0, err = '', authRetry = false;
    const fail = (m) => { err = m; if (++fails >= 5) { this.saveIndex(); this.onEvent({ type: 'net', path: entry.path, phase: 'error', error: err }); throw new Error(`No se pudo descargar ${entry.path}: ${err}`); } };
    while (this.index.get(entry.h).length === 3) {
      if (e[2] >= e[1]) { if (!this.finish(entry.h, sha256(this.readAt(e[0], e[1])))) fail('hash distinto'); continue; }
      if (this.origin.stale()) this.origin.refreshSync();
      const from = e[2], to = Math.min(e[1], from + CHUNK) - 1, whole = from === 0 && to === e[1] - 1;
      const x = new XMLHttpRequest(); x.open('GET', this.origin.fileUrl(entry.path), false); x.responseType = 'arraybuffer';
      if (!whole) x.setRequestHeader('Range', `bytes=${from}-${to}`);
      try { x.send(); } catch (ex) { fail(String(ex.message || ex)); continue; }
      if ((x.status === 401 || x.status === 403) && this.origin.tokenMode && !authRetry) { authRetry = true; this.origin.refreshSync(); continue; }
      const b = new Uint8Array(x.response || new ArrayBuffer(0));
      if (x.status === 200 && b.length === e[1]) { this.writeAt(e[0], b); e[2] = e[1]; }
      else if (x.status === 206 && b.length === to - from + 1) { this.writeAt(e[0] + from, b); e[2] = to + 1; }
      else { fail(`HTTP ${x.status} (${b.length} bytes)`); continue; }
      fails = 0; authRetry = false; this.saveIndex();
      if (e[1] > CHUNK) this.onEvent({ type: 'net', path: entry.path, size: entry.size, got: e[2], phase: 'progress' });
    }
    this.saveIndex(); this.stats.downloads++; this.stats.bytes += entry.size;
    this.onEvent({ type: 'net', path: entry.path, size: entry.size, phase: 'done' });
    return this.readHash(entry.h);
  }
  // descarga anticipada (asíncrona, en paralelo) de las entradas que faltan; progreso real en bytes; reanudable
  async prefetch(entries, onProgress, parallel = 6) {
    const todo = entries.filter((e) => !this.has(e.h));
    const total = todo.reduce((a, e) => a + e.size - this.partialBytes(e.h), 0); let done = 0, files = 0;
    const t0 = performance.now(); let i = 0, lastSave = performance.now();
    const tick = (path) => { onProgress({ done, total, files, count: todo.length, path, mbps: done / 1048576 / Math.max(0.001, (performance.now() - t0) / 1000) });
      if (performance.now() - lastSave > 2000) { lastSave = performance.now(); this.saveIndex(); } };
    const one = async (entry) => {
      const e = this.reserve(entry); let fails = 0, err = '', authRetry = false;
      while (this.index.get(entry.h).length === 3) {
        if (fails >= 5) throw new Error(`No se pudo descargar ${entry.path}: ${err}`);
        if (e[2] >= e[1]) { if (!this.finish(entry.h, hex(await crypto.subtle.digest('SHA-256', this.readAt(e[0], e[1]))))) { done -= e[1]; err = 'hash distinto'; fails++; } continue; }
        if (this.origin.stale()) await this.origin.refresh();
        const from = e[2], to = Math.min(e[1], from + CHUNK) - 1, whole = from === 0 && to === e[1] - 1;
        try {
          const r = await fetch(this.origin.fileUrl(entry.path), { headers: whole ? {} : { Range: `bytes=${from}-${to}` } });
          if ((r.status === 401 || r.status === 403) && this.origin.tokenMode && !authRetry) { authRetry = true; await this.origin.refresh(); continue; }
          if (!(r.status === 200 && from === 0) && r.status !== 206) { err = `HTTP ${r.status}`; fails++; continue; }
          const rd = r.body.getReader(); let pos = from;                          // se escribe a medida que llega: un corte conserva lo recibido
          for (;;) { const { done: d, value } = await rd.read(); if (d) break;
            if (pos + value.length > e[1]) { err = 'tamaño distinto'; break; }
            this.writeAt(e[0] + pos, value); pos += value.length; e[2] = pos; done += value.length; tick(entry.path); }
          if (err === 'tamaño distinto') { done -= pos - from; e[2] = from; fails++; continue; }
          if (r.status === 206 && pos !== to + 1 && pos !== e[1]) { err = 'corte de conexión'; fails++; continue; }
          fails = 0; authRetry = false;
        } catch (x) { err = String(x.message || x); fails++; }
      }
      files++; tick(entry.path);
    };
    const worker = async () => { while (i < todo.length) await one(todo[i++]); };
    try { await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker)); } finally { this.saveIndex(); }
    onProgress({ done: total, total, files, count: todo.length, finished: true, resumed: this.stats.resumed });
    return { files: todo.length, bytes: total };
  }
}
