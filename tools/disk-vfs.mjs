// VFS sobre la carpeta del juego en disco (solo Node, solo lectura; las escrituras quedan en memoria).
import fs from 'node:fs';
import path from 'node:path';

export class DiskVFS {
  constructor(root) {
    this.root = root; this.cwd = ''; this.files = new Map(); this.index = new Map(); this.dirs = new Set(['']);
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '\\' + e.name : e.name; const key = r.toUpperCase();
      if (e.isDirectory()) { this.dirs.add(key); walk(path.join(d, e.name), r); } else this.index.set(key, path.join(d, e.name)); } };
    walk(root, ''); this.opened = new Map();
  }
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
  add(p, data) { this.files.set(this.norm('\\F1C\\' + p), { name: p, data }); }
  find(p) {
    const n = this.norm(p);
    if (this.files.has(n)) return this.files.get(n);
    const hp = this.index.get(n);
    if (!hp) return null;
    const f = { name: path.basename(hp), data: new Uint8Array(fs.readFileSync(hp)) };
    this.files.set(n, f); this.opened.set(n, f.data.length); return f;
  }
  isDir(p) { return this.dirs.has(this.norm(p)); }
  create(p) { const n = this.norm(p); const f = { name: p, data: new Uint8Array(0) }; this.files.set(n, f); return f; }
  list(pattern) {
    const n = this.norm(pattern); const i = n.lastIndexOf('\\');
    const dir = i >= 0 ? n.slice(0, i) : ''; let pat = n.slice(i + 1); if (pat === '*.*') pat = '*';
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const out = new Map();
    const pref = dir ? dir + '\\' : '';
    const consider = (k, isDir) => { if (!k.startsWith(pref)) return; const rest = k.slice(pref.length); if (!rest || rest.includes('\\')) return;
      if (re.test(rest)) out.set(rest, { name: rest, isDir, size: isDir ? 0 : (this.files.get(k)?.data.length ?? fs.statSync(this.index.get(k)).size) }); };
    for (const k of this.dirs) consider(k, true);
    for (const k of this.index.keys()) consider(k, false);
    for (const k of this.files.keys()) consider(k, false);
    return [...out.values()];
  }
}
