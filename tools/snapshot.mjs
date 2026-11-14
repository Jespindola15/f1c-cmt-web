// Envoltorio Node de src/snapshot.js: guarda/lee state.bin + mem.bin en una carpeta.
import fs from 'node:fs';
import path from 'node:path';
import { take, restore as restoreCore } from '../src/snapshot.js';
export function save(emu, dir) { fs.mkdirSync(dir, { recursive: true }); const s = take(emu); fs.writeFileSync(path.join(dir, 'state.bin'), s.state); fs.writeFileSync(path.join(dir, 'mem.bin'), s.mem); return { pages: s.pages, icount: s.icount }; }
export function restore(dir, makeVfs, opts = {}) { return restoreCore({ state: new Uint8Array(fs.readFileSync(path.join(dir, 'state.bin'))), mem: new Uint8Array(fs.readFileSync(path.join(dir, 'mem.bin'))) }, makeVfs, opts); }
