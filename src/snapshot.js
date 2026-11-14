// snapshot.js — instantáneas portables del emulador (Node y navegador).
//   take(emu) -> { state: Uint8Array, mem: Uint8Array }   ;  restore({state, mem}, makeVfs, opts) -> Emulator
// mem: secuencia de [dirección u32][4096 bytes] de páginas no nulas.
import { Emulator, MODULES } from './emulator.js';
import { comTable as d3dTable } from './win32/d3d8.js';
import { comTable as diTable } from './win32/dinput8.js';
import { serialize, deserialize } from './serial.js';
const SKIP = new Set(['logFn', 'host', 'mem', 'cpu', 'jit', 'vfs', 'thunks', 'thunkByName', 'keyEvent', 'ddPaletteOf', 'scanout', 'apiTrace', '_ring', '_ringPos', '_argv', 'onPresent', 'd3dBackend', 'audioHost', 'joyState', 'keys', 'mouse']);
export function take(emu) {
  const m = emu.mem, c = emu.cpu, f = c.fpu;
  let pages = 0; for (let p = 0; p < m.size; p += 4096) if (!isZero(m.u8, p)) pages++;
  const mem = new Uint8Array(pages * 4100); const mv = new DataView(mem.buffer); let o = 0;
  for (let p = 0; p < m.size; p += 4096) if (!isZero(m.u8, p)) { mv.setUint32(o, p, true); mem.set(m.u8.subarray(p, p + 4096), o + 4); o += 4100; }
  const emuFields = {}; for (const k of Object.keys(emu)) if (!SKIP.has(k) && typeof emu[k] !== 'function') emuFields[k] = emu[k];
  const written = new Map(); for (const [k, v] of emu.vfs.files) if (!emu.vfs.opened.has(k)) written.set(k, v);
  const state = serialize({
    cpu: { r: [...c.r], eip: c.eip, eflags: c.eflags, fsBase: c.fsBase, icount: c.icount, cpuidEdx: c.cpuidEdx,
      fpu: { st: f.st, top: f.top, cw: f.cw, tagEmpty: f.tagEmpty, c0: f.c0, c1: f.c1, c2: f.c2, c3: f.c3 },
      simd: { x: new Uint8Array(c.simd.xbuf), m: new Uint8Array(c.simd.mbuf), mxcsr: c.simd.mxcsr } },
    mem: { heapPtr: m.heapPtr, blocks: m.blocks, freeList: m.freeList },
    vfs: { cwd: emu.vfs.cwd, written },
    thunks: emu.thunks.map((t) => ({ dll: t.dll, name: t.name, addr: t.addr })),
    emu: emuFields,
  });
  return { state, mem, pages, icount: c.icount };
}
function isZero(u8, p) { for (let i = p; i < p + 4096; i += 8) if (u8[i] | u8[i + 1] | u8[i + 2] | u8[i + 3] | u8[i + 4] | u8[i + 5] | u8[i + 6] | u8[i + 7]) return false; return true; }
export function restore({ state, mem }, makeVfs, opts = {}) {
  const st = deserialize(state);
  const emu = new Emulator(opts);
  const m = emu.mem, c = emu.cpu;
  const mv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  for (let o = 0; o < mem.length; o += 4100) m.u8.set(mem.subarray(o + 4, o + 4100), mv.getUint32(o, true));
  Object.assign(m, st.mem);
  c.r.set(st.cpu.r); c.eip = st.cpu.eip; c.eflags = st.cpu.eflags; c.fsBase = st.cpu.fsBase; c.icount = st.cpu.icount; if (st.cpu.cpuidEdx !== undefined) c.cpuidEdx = st.cpu.cpuidEdx;
  Object.assign(c.fpu, st.cpu.fpu); new Uint8Array(c.simd.xbuf).set(st.cpu.simd.x); new Uint8Array(c.simd.mbuf).set(st.cpu.simd.m); c.simd.mxcsr = st.cpu.simd.mxcsr;
  Object.assign(emu, st.emu);
  emu.vfs = makeVfs(); emu.vfs.cwd = st.vfs.cwd; for (const [k, v] of st.vfs.written) emu.vfs.files.set(k, v);
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
