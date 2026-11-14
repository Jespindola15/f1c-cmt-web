// netcache.js — archivos del juego desde un origen HTTPS autorizado (p.ej. Cloudflare R2) con caché persistente en OPFS.
// Formato del origen:  <base>/manifest.json  y  <base>/files/<ruta con />   (ver tools/make-content.mjs)
// Caché (OPFS f1c-net/): data.bin (contenido concatenado) + index.json (hash SHA-256 -> desplazamiento, tamaño).
// Indexada por hash: si el manifiesto cambia, sólo se descargan los archivos que cambiaron.
// Se usa en el worker del emulador: lecturas síncronas con FileSystemSyncAccessHandle; los archivos que el juego
// pide y no están en caché se bajan con XHR síncrono (el código x86 espera dentro de ReadFile/CreateFile).
import { sha256 } from '../src/sha256.js';
export const fileUrl = (base, p) => base + 'files/' + p.split(/[\\/]/).map(encodeURIComponent).join('/');
export class NetCache {
  static async open(base, onEvent, key = '') {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('f1c-net', { create: true });
    const data = await (await root.getFileHandle('data.bin', { create: true })).createSyncAccessHandle();
    const idxH = await (await root.getFileHandle('index.json', { create: true })).createSyncAccessHandle();
    const c = new NetCache(); c.base = base; c.key = key; c.data = data; c.idxH = idxH; c.onEvent = onEvent || (() => {});
    let idx = {}; const n = idxH.getSize(); if (n) { const b = new Uint8Array(n); idxH.read(b, { at: 0 }); try { idx = JSON.parse(new TextDecoder().decode(b)); } catch { idx = {}; } }
    c.index = new Map(Object.entries(idx.files || {})); c.end = data.getSize();
    // si el índice apunta más allá del final (corte a mitad de escritura), descartar esas entradas
    for (const [h, e] of c.index) if (e[0] + e[1] > c.end) c.index.delete(h);
    c.dirty = false; c.stats = { hits: 0, downloads: 0, bytes: 0 };
    return c;
  }
  has(h) { return this.index.has(h); }
  saveIndex() { const b = new TextEncoder().encode(JSON.stringify({ files: Object.fromEntries(this.index) })); this.idxH.truncate(0); this.idxH.write(b, { at: 0 }); this.idxH.flush(); this.dirty = false; }
  put(h, bytes) { if (this.index.has(h)) return; let w = 0; while (w < bytes.length) w += this.data.write(bytes.subarray(w), { at: this.end + w }); this.index.set(h, [this.end, bytes.length]); this.end += bytes.length; this.dirty = true; }
  readHash(h) { const e = this.index.get(h); if (!e) return null; const b = new Uint8Array(e[1]); let r = 0; while (r < e[1]) { const k = this.data.read(b.subarray(r), { at: e[0] + r }); if (k <= 0) break; r += k; } this.stats.hits++; return b; }
  // lectura para el VFS (síncrona): caché o descarga inmediata
  read(entry) {
    const c = this.readHash(entry.h); if (c) return c;
    this.onEvent({ type: 'net', path: entry.path, size: entry.size, phase: 'start' });
    let bytes = null, err = '';
    for (let attempt = 0; attempt < 3 && !bytes; attempt++) {
      const x = new XMLHttpRequest(); x.open('GET', fileUrl(this.base, entry.path), false); x.responseType = 'arraybuffer'; if (this.key) x.setRequestHeader('X-F1C-Key', this.key);
      try { x.send(); } catch (e) { err = String(e); continue; }
      if (x.status !== 200) { err = `HTTP ${x.status}`; continue; }
      const b = new Uint8Array(x.response);
      if (b.length !== entry.size || sha256(b) !== entry.h) { err = 'hash/tamaño distinto'; continue; }
      bytes = b;
    }
    if (!bytes) { this.onEvent({ type: 'net', path: entry.path, phase: 'error', error: err }); throw new Error(`No se pudo descargar ${entry.path}: ${err}`); }
    this.put(entry.h, bytes); this.saveIndex(); this.data.flush();
    this.stats.downloads++; this.stats.bytes += bytes.length;
    this.onEvent({ type: 'net', path: entry.path, size: entry.size, phase: 'done' });
    return bytes;
  }
  // descarga anticipada (asíncrona, en paralelo) de una lista de entradas que faltan; progreso real en bytes
  async prefetch(entries, onProgress, parallel = 6) {
    const todo = entries.filter((e) => !this.index.has(e.h)); const total = todo.reduce((a, e) => a + e.size, 0); let done = 0, files = 0;
    const t0 = performance.now(); let i = 0, lastSave = performance.now();
    const worker = async () => {
      while (i < todo.length) { const e = todo[i++];
        let ok = false, err = '';
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const r = await fetch(fileUrl(this.base, e.path), { headers: this.key ? { 'X-F1C-Key': this.key } : {} }); if (!r.ok) { err = `HTTP ${r.status}`; continue; }
            const rd = r.body.getReader(); const buf = new Uint8Array(e.size); let got = 0;
            for (;;) { const { done: d, value } = await rd.read(); if (d) break; if (got + value.length > e.size) { err = 'tamaño distinto'; break; } buf.set(value, got); got += value.length; done += value.length; onProgress({ done, total, files, count: todo.length, path: e.path, mbps: done / 1048576 / ((performance.now() - t0) / 1000) }); }
            if (got !== e.size) { done -= got; err = err || 'tamaño distinto'; continue; }
            const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join('');
            if (h !== e.h) { done -= got; err = 'hash distinto'; continue; }
            this.put(e.h, buf); ok = true; files++;
            if (performance.now() - lastSave > 2000) { lastSave = performance.now(); this.data.flush(); this.saveIndex(); }
          } catch (x) { err = String(x.message || x); }
        }
        if (!ok) throw new Error(`No se pudo descargar ${e.path}: ${err}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
    this.data.flush(); this.saveIndex();
    onProgress({ done: total, total, files, count: todo.length, finished: true });
    return { files: todo.length, bytes: total };
  }
}
