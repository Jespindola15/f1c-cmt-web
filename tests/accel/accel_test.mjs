// Aceleradores vs. rutina original del exe: mismos bytes en memoria y mismas variables globales.
//   node tests/accel/accel_test.mjs "<carpeta del juego>"
import fs from 'node:fs';
import { Emulator } from '../../src/emulator.js';
import { ACCELS, installAccel } from '../../src/accel.js';
const GAME = process.argv[2];
const exe = new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe'));
let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
function mk(accel) { const e = new Emulator({ log: () => {} }); e.loadMain(exe, 'F1C_CMT.EXE'); if (accel) installAccel(e); return e; }
const A = mk(false), B = mk(true);
const SRC = 0x20000000, DST = 0x21000000; let fails = 0, n = 0;
for (let t = 0; t < 400; t++) {
  const w = [0, 1, 3, 17, 64, 200][rnd() % 6], h = [0, 1, 2, 9, 33][rnd() % 5], sP = (w + (rnd() % 8)) * 4, dP = (w + (rnd() % 8)) * 4;
  const key = [0xffffffff, 0x00ff00ff, 0xff000000, 0x00000000, rnd()][rnd() % 5];
  const fill = (e) => { let s2 = t * 977 + 1; for (let i = 0; i < 0x10000; i += 4) { s2 = (Math.imul(s2, 1103515245) + 12345) >>> 0; const v = (s2 & 3) === 0 ? (key & 0xffffff) : s2; e.mem.w32(SRC + i, v); e.mem.w32(DST + i, 0xdeadbeef ^ i); } };
  const res = [];
  for (const e of [A, B]) { fill(e); e.callGuest(0x560a82, [SRC, sP, DST, dP, w, h, key]);
    let hsh = 0; for (let i = 0; i < 0x10000; i += 4) hsh = (Math.imul(hsh, 31) + e.mem.r32(DST + i)) >>> 0;
    res.push([hsh, e.mem.r32(0x5dd844), e.mem.r32(0x5dd804), e.mem.r32(0x5dd814)].join(',')); }
  n++; if (res[0] !== res[1]) { if (fails++ < 5) console.log('DIFERENCIA', { w, h, sP, dP, key: key.toString(16) }, res); }
}
console.log(`blit32: ${n - fails}/${n} idénticos (aceleradores: ${ACCELS.map((a) => a.name).join(', ')})`);
