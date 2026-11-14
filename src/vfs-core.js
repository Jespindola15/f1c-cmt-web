// vfs-core.js — sistema de archivos virtual del juego (independiente del entorno: Node o navegador).
// La instalación del jugador es de SOLO LECTURA: lo que el juego escribe (partidas, configuración, .HAT, registros)
// va a una capa propia que el entorno persiste (OPFS en Chrome). Rutas Windows: C:\F1C\... = raíz del juego.
// Origen de los datos: `source.read(entry)` síncrono (disco en Node, paquete OPFS o XHR en el navegador).
// Caché de lectura con límite (LRU) para no retener cientos de MB de .MAS en memoria.
export class GameVFS {
  constructor({ entries = [], dirs = [], source, cacheBytes = 256 << 20, onWrite = null, onDelete = null }) {
    this.cwd = ''; this.source = source; this.onWrite = onWrite; this.onDelete = onDelete;
    this.index = new Map(); this.dirs = new Set(['']); this.files = new Map(); this.opened = new Map();
    this.cacheBytes = cacheBytes; this.cached = 0; this.lru = new Map(); // clave -> tamaño (orden de uso)
    for (const e of entries) this.addEntry(e);
    for (const d of dirs) this.addDir(d);
  }
  key(p) { return String(p).replace(/\//g, '\\').toUpperCase(); }
  addEntry(e) { const k = this.key(e.path); this.index.set(k, e); const i = k.lastIndexOf('\\'); if (i > 0) this.addDir(k.slice(0, i)); }
  addDir(d) { let k = this.key(d); while (k && !this.dirs.has(k)) { this.dirs.add(k); const i = k.lastIndexOf('\\'); k = i > 0 ? k.slice(0, i) : ''; } }
  norm(p) {
    p = String(p).replace(/\//g, '\\').toUpperCase();
    const abs = /^[A-Z]:/.test(p) || p.startsWith('\\');
    p = p.replace(/^[A-Z]:/, '');
    if (!abs && this.cwd) p = this.cwd + '\\' + p;
    const parts = [];
    for (const s of p.split('\\')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
    if (abs && parts[0] === 'F1C') parts.shift();
    return parts.join('\\');
  }
  // archivo agregado por el entorno (p.ej. Config.ini adaptado): se comporta como escrito por el juego
  add(p, data) { const n = this.norm('\\F1C\\' + p); this.files.set(n, { name: p.split(/[\\/]/).pop(), data, written: true }); }
  touch(n, size) { if (this.lru.has(n)) this.lru.delete(n); else this.cached += size; this.lru.set(n, size);
    while (this.cached > this.cacheBytes && this.lru.size > 1) { const [k, sz] = this.lru.entries().next().value; this.lru.delete(k); this.cached -= sz; const f = this.files.get(k); if (f && !f.written) this.files.delete(k); } }
  find(p) {
    const n = this.norm(p);
    const f0 = this.files.get(n); if (f0) { if (!f0.written) this.touch(n, f0.data.length); return f0; }
    const e = this.index.get(n); if (!e) return null;
    const data = this.source.read(e); if (!data) return null;
    const f = { name: e.path.split(/[\\/]/).pop(), data };
    this.files.set(n, f); this.opened.set(n, data.length); this.touch(n, data.length);
    return f;
  }
  isDir(p) { return this.dirs.has(this.norm(p)); }
  create(p) { const n = this.norm(p); const f = { name: String(p).split(/[\\/]/).pop(), data: new Uint8Array(0), written: true }; this.files.set(n, f); const i = n.lastIndexOf('\\'); if (i > 0) this.addDir(n.slice(0, i)); return f; }
  mkdir(p) { this.addDir(this.norm(p)); }
  // el juego cerró/escribió un archivo: persistir
  written(f) { f.written = true; for (const [k, v] of this.files) if (v === f) { this.lru.delete(k); this.onWrite?.(k, f.data); return; } }
  remove(p) { const n = this.norm(p); const had = this.files.delete(n) | this.index.delete(n); if (had) this.onDelete?.(n); return !!had; }
  size(k) { return this.files.get(k)?.data.length ?? this.index.get(k)?.size ?? 0; }
  list(pattern) {
    const n = this.norm(pattern); const i = n.lastIndexOf('\\');
    const dir = i >= 0 ? n.slice(0, i) : ''; let pat = n.slice(i + 1); if (pat === '*.*') pat = '*';
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const out = new Map(); const pref = dir ? dir + '\\' : '';
    const consider = (k, isDir) => { if (!k.startsWith(pref)) return; const rest = k.slice(pref.length); if (!rest || rest.includes('\\')) return;
      if (re.test(rest)) out.set(rest, { name: isDir ? rest : (this.index.get(k)?.path.split(/[\\/]/).pop() ?? this.files.get(k)?.name ?? rest), isDir, size: isDir ? 0 : this.size(k) }); };
    for (const k of this.dirs) consider(k, true);
    for (const k of this.index.keys()) consider(k, false);
    for (const k of this.files.keys()) consider(k, false);
    return [...out.values()];
  }
}
// Exclusiones al importar/indexar la instalación (no los usa el juego o no aplican en el navegador)
export const SKIP_RE = /^(CMTSeasonData\.zip|Audio[\\/]Vehicle\.zip|CMTSeasonData[\\/]Circuits\.zip|SelectDirectXInstaller|Support|Src|Permissions|Telemetry|main\.dmp|.*\.(pdf|jar|url)$)/i;
