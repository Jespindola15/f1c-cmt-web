// VFS sobre la carpeta del juego en disco (Node). Solo lectura: las escrituras quedan en memoria (o en OUT_DIR si se indica).
import fs from 'node:fs';
import path from 'node:path';
import { GameVFS, SKIP_RE } from '../src/vfs-core.js';
export class DiskVFS extends GameVFS {
  constructor(root, opts = {}) {
    const entries = [], dirs = [];
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '\\' + e.name : e.name; if (SKIP_RE.test(r) && !opts.all) continue;
      if (e.isDirectory()) { dirs.push(r); walk(path.join(d, e.name), r); } else entries.push({ path: r, size: fs.statSync(path.join(d, e.name)).size, file: path.join(d, e.name) }); } };
    walk(root, '');
    super({ entries, dirs, source: { read: (e) => new Uint8Array(fs.readFileSync(e.file)) }, cacheBytes: opts.cacheBytes ?? (512 << 20) });
    this.root = root;
  }
}
