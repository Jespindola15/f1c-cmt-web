// Envoltorio Node de src/snapshot.js: guarda/lee state.bin + mem.bin en una carpeta.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { take, restore as restoreCore } from '../src/snapshot.js';
export function save(emu, dir) {
  fs.mkdirSync(dir, { recursive: true }); for (const f of fs.readdirSync(dir)) if (/^mem/.test(f)) fs.unlinkSync(path.join(dir, f));
  // los trozos de memoria se comprimen y escriben a medida que se generan (poca memoria extra)
  const s = take(emu, (p, i) => fs.writeFileSync(path.join(dir, `mem.${String(i).padStart(3, '0')}.z`), zlib.deflateSync(p, { level: 1 })));
  fs.writeFileSync(path.join(dir, 'state.bin'), s.state);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ chunks: fs.readdirSync(dir).filter((f) => /^mem\.\d+\.z$/.test(f)).length, pages: s.pages, icount: s.icount }));
  return { pages: s.pages, icount: s.icount };
}
export function restore(dir, makeVfs, opts = {}) {
  const st = new Uint8Array(fs.readFileSync(path.join(dir, 'state.bin')));
  const zs = fs.readdirSync(dir).filter((f) => /^mem\.\d+\.z$/.test(f)).sort();
  let mem;
  if (zs.length) mem = zs.map((f) => () => new Uint8Array(zlib.inflateSync(fs.readFileSync(path.join(dir, f)))));
  else if (fs.existsSync(path.join(dir, 'mem.bin.z'))) mem = new Uint8Array(zlib.inflateSync(fs.readFileSync(path.join(dir, 'mem.bin.z'))));
  else mem = new Uint8Array(fs.readFileSync(path.join(dir, 'mem.bin')));
  return restoreCore({ state: st, mem }, makeVfs, opts);
}
