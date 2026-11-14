// Aceleradores vs. rutina original del exe: mismos bytes en memoria y mismas variables globales.
//   node tests/accel/accel_test.mjs "<carpeta del juego>"
import fs from 'node:fs';
import { Emulator } from '../../src/emulator.js';
import { ACCELS_ALL as ACCELS, installAccel } from '../../src/accel.js';
const GAME = process.argv[2];
const exe = new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe'));
let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
function mk(accel) { const e = new Emulator({ log: () => {} }); e.loadMain(exe, 'F1C_CMT.EXE'); if (accel) installAccel(e, ACCELS); return e; }
const A = mk(false), B = mk(true);
const SRC = 0x20000000, DST = 0x21000000; let fails = 0, n = 0;
for (let t = 0; t < 400; t++) {
  const w = [0, 1, 3, 17, 64, 200][rnd() % 6], h = [0, 1, 2, 9, 33][rnd() % 5], sP = (w + (rnd() % 8)) * 4, dP = (w + (rnd() % 8)) * 4;
  const key = [0xffffffff, 0x00ff00ff, 0xff000000, 0x00000000, rnd()][rnd() % 5];
  const fill = (e) => { let s2 = t * 977 + 1; for (let i = 0; i < 0x10000; i += 4) { s2 = (Math.imul(s2, 1103515245) + 12345) >>> 0; const v = (s2 & 3) === 0 ? (key & 0xffffff) : s2; e.mem.w32(SRC + i, v); e.mem.w32(DST + i, 0xdeadbeef ^ i); } };
  const res = [];
  for (const e of [A, B]) { fill(e); const i0 = e.cpu.icount; e.callGuest(0x560a82, [SRC, sP, DST, dP, w, h, key]); const di = e.cpu.icount - i0;
    let hsh = 0; for (let i = 0; i < 0x10000; i += 4) hsh = (Math.imul(hsh, 31) + e.mem.r32(DST + i)) >>> 0;
    res.push([hsh, e.mem.r32(0x5dd844), e.mem.r32(0x5dd804), e.mem.r32(0x5dd814), di].join(',')); }
  n++; if (res[0] !== res[1]) { if (fails++ < 5) console.log('DIFERENCIA', { w, h, sP, dP, key: key.toString(16) }, res); }
}
console.log(`blit32: ${n - fails}/${n} idénticos (aceleradores: ${ACCELS.map((a) => a.name).join(', ')})`);

// ---- transformaciones x87 ----
{
  const V = 0x22000000, M = 0x22000100, OUT = 0x22000200; let bad = 0, cnt = 0;
  const fl = () => { const k = rnd() % 10; if (k === 0) return 0; if (k === 1) return -0; const x = ((rnd() / 4294967296) - 0.5) * (k < 5 ? 2 : 2000); return Math.fround(x); };
  for (const [addr, wrapper] of [[0x55ef24, 0], [0x55eeaf, 0], [0x53bea0, 1], [0x53bec0, 1]]) for (let t = 0; t < 300; t++) {
    const vals = Array.from({ length: 19 }, fl); const regs = Array.from({ length: 8 }, () => rnd()); const top = rnd() & 7; const st = Array.from({ length: 8 }, fl);
    const res = [];
    for (const e of [A, B]) {
      const m = e.mem; for (let i = 0; i < 3; i++) m.wf32(V + 4 * i, vals[i]); for (let i = 0; i < 16; i++) m.wf32(M + 4 * i, vals[3 + i]); for (let i = 0; i < 4; i++) m.w32(OUT + 4 * i, 0x7fc00000 + i);
      e.cpu.fpu.top = top; e.cpu.fpu.st.set(st); e.cpu.fpu.tagEmpty.fill(1);
      const save = [...e.cpu.r]; for (const i of [0, 1, 2, 3, 5, 6, 7]) e.cpu.r[i] = regs[i];
      const sp0 = e.cpu.r[4]; for (let i = 0; i < 128; i += 4) m.w32(sp0 - 64 - i, 0x55555555);
      const i0 = e.cpu.icount; e.callGuest(addr, wrapper ? [0x1234, V, OUT, M] : [V, OUT, M]); const di = e.cpu.icount - i0;
      let h = 0; for (let i = -160; i < 16; i += 4) h = (Math.imul(h, 31) + m.r32(sp0 + i)) >>> 0;
      res.push([[0, 1, 2, 3].map((i) => m.r32(OUT + 4 * i)).join(':'), h, [...e.cpu.r].join(':'), e.cpu.fpu.top, [...e.cpu.fpu.st].join(':'), [...e.cpu.fpu.tagEmpty].join(''), di].join('|'));
      e.cpu.r.set(save);
    }
    cnt++; if (res[0] !== res[1]) { if (bad++ < 4) console.log('DIFERENCIA', addr.toString(16), '\n', res[0], '\n', res[1]); }
  }
  console.log(`transformaciones x87: ${cnt - bad}/${cnt} idénticos`);
}
