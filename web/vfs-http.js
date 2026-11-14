// VFS del navegador: índice desde /game/manifest.json; cada archivo se descarga la primera vez que el juego
// lo abre (XHR síncrono, permitido en Workers) y queda en memoria. Escrituras: en memoria (luego OPFS).
export class HttpVFS {
  constructor(base, manifest) {
    this.base = base; this.cwd = ''; this.files = new Map(); this.index = new Map(); this.dirs = new Set(['']); this.opened = new Map(); this.bytes = 0;
    for (const [p, size] of manifest.files) this.index.set(p.replace(/\//g, '\\').toUpperCase(), { path: p, size });
    for (const d of manifest.dirs) this.dirs.add(d.replace(/\//g, '\\').toUpperCase());
  }
  norm(p) {
    p = String(p).replace(/\//g, '\\').toUpperCase(); const abs = /^[A-Z]:/.test(p) || p.startsWith('\\'); p = p.replace(/^[A-Z]:/, '');
    if (!abs && this.cwd) p = this.cwd + '\\' + p;
    const parts = []; for (const s of p.split('\\')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
    if (abs && parts[0] === 'F1C') parts.shift(); return parts.join('\\');
  }
  add(p, data) { this.files.set(this.norm('\\F1C\\' + p), { name: p, data }); }
  fetchSync(path) { const x = new XMLHttpRequest(); x.open('GET', this.base + path.split('/').map(encodeURIComponent).join('/'), false); x.responseType = 'arraybuffer'; x.send(); if (x.status !== 200) return null; return new Uint8Array(x.response); }
  find(p) {
    const n = this.norm(p); if (this.files.has(n)) return this.files.get(n);
    const e = this.index.get(n); if (!e) return null;
    const data = this.fetchSync(e.path); if (!data) return null;
    const f = { name: e.path.split('/').pop(), data }; this.files.set(n, f); this.opened.set(n, data.length); this.bytes += data.length; return f;
  }
  isDir(p) { return this.dirs.has(this.norm(p)); }
  create(p) { const n = this.norm(p); const f = { name: p, data: new Uint8Array(0) }; this.files.set(n, f); return f; }
  list(pattern) {
    const n = this.norm(pattern); const i = n.lastIndexOf('\\'); const dir = i >= 0 ? n.slice(0, i) : ''; let pat = n.slice(i + 1); if (pat === '*.*') pat = '*';
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); const out = new Map(); const pref = dir ? dir + '\\' : '';
    const consider = (k, isDir, size) => { if (!k.startsWith(pref)) return; const rest = k.slice(pref.length); if (!rest || rest.includes('\\')) return; if (re.test(rest)) out.set(rest, { name: rest, isDir, size }); };
    for (const k of this.dirs) consider(k, true, 0);
    for (const [k, v] of this.index) consider(k, false, this.files.get(k)?.data.length ?? v.size);
    for (const [k, v] of this.files) consider(k, false, v.data.length);
    return [...out.values()];
  }
}
