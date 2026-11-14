// Instantáneas del emulador (solo Node): guardar y restaurar el estado completo para continuar una corrida larga
// en otra invocación. Memoria: páginas de 4 KiB no nulas. Resto: v8.serialize (conserva Maps, typed arrays y referencias).
import fs from 'node:fs';
import v8 from 'node:v8';
import path from 'node:path';
import { Emulator, MODULES } from '../src/emulator.js';
import { comTable as d3dTable } from '../src/win32/d3d8.js';
import { comTable as diTable } from '../src/win32/dinput8.js';
const SKIP = new Set(['logFn', 'host', 'mem', 'cpu', 'jit', 'vfs', 'thunks', 'thunkByName', 'keyEvent', 'ddPaletteOf', 'scanout', 'apiTrace', 'onPresent', 'd3dBackend', 'audioHost']);
export function save(emu, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const m = emu.mem, c = emu.cpu, f = c.fpu;
  const fd = fs.openSync(path.join(dir, 'mem.bin'), 'w'); const hdr = Buffer.alloc(4); let pages = 0;
  for (let p = 0; p < m.size; p += 4096) { const u = m.u8.subarray(p, p + 4096); if (u.some((x) => x)) { hdr.writeUInt32LE(p); fs.writeSync(fd, hdr); fs.writeSync(fd, u); pages++; } }
  fs.closeSync(fd);
  const emuFields = {}; for (const k of Object.keys(emu)) if (!SKIP.has(k) && typeof emu[k] !== 'function') emuFields[k] = emu[k];
  const written = new Map(); for (const [k, v] of emu.vfs.files) if (!emu.vfs.opened.has(k)) written.set(k, v);
  const st = {
    cpu: { r: [...c.r], eip: c.eip, eflags: c.eflags, fsBase: c.fsBase, icount: c.icount, cpuidEdx: c.cpuidEdx,
      fpu: { st: f.st, top: f.top, cw: f.cw, tagEmpty: f.tagEmpty, c0: f.c0, c1: f.c1, c2: f.c2, c3: f.c3 },
      simd: { x: new Uint8Array(c.simd.xbuf), m: new Uint8Array(c.simd.mbuf), mxcsr: c.simd.mxcsr } },
    mem: { heapPtr: m.heapPtr, blocks: m.blocks, freeList: m.freeList },
    vfs: { cwd: emu.vfs.cwd, written },
    thunks: emu.thunks.map((t) => ({ dll: t.dll, name: t.name, addr: t.addr })),
    emu: emuFields,
  };
  fs.writeFileSync(path.join(dir, 'state.bin'), v8.serialize(st));
  return { pages, icount: c.icount };
}
export function restore(dir, makeVfs, opts = {}) {
  const st = v8.deserialize(fs.readFileSync(path.join(dir, 'state.bin')));
  const emu = new Emulator(opts);
  const m = emu.mem, c = emu.cpu;
  const buf = fs.readFileSync(path.join(dir, 'mem.bin'));
  for (let o = 0; o < buf.length; o += 4100) m.u8.set(buf.subarray(o + 4, o + 4100), buf.readUInt32LE(o));
  Object.assign(m, st.mem);
  c.r.set(st.cpu.r); c.eip = st.cpu.eip; c.eflags = st.cpu.eflags; c.fsBase = st.cpu.fsBase; c.icount = st.cpu.icount; if (st.cpu.cpuidEdx !== undefined) c.cpuidEdx = st.cpu.cpuidEdx;
  Object.assign(c.fpu, st.cpu.fpu); new Uint8Array(c.simd.xbuf).set(st.cpu.simd.x); new Uint8Array(c.simd.mbuf).set(st.cpu.simd.m); c.simd.mxcsr = st.cpu.simd.mxcsr;
  Object.assign(emu, st.emu);
  emu.vfs = makeVfs(); emu.vfs.cwd = st.vfs.cwd; for (const [k, v] of st.vfs.written) emu.vfs.files.set(k, v);
  // los handles abiertos apuntan a copias de archivos: se mantienen tal cual (lectura de su contenido guardado)
  const com = new Map([...d3dTable(), ...diTable()]);
  emu.thunks = []; emu.thunkByName = new Map();
  for (const t of st.thunks) {
    let impl;
    if (t.dll === 'COM') { impl = com.get(t.name); if (!impl) throw new Error(`Instantánea: método COM desconocido ${t.name}`); }
    else { impl = MODULES[t.dll]?.[t.name]; emu.thunkByName.set(t.dll + '!' + t.name, t.addr); }
    emu.thunks.push({ dll: t.dll, name: t.name, impl, addr: t.addr });
  }
  return emu;
}
