// MMX traducido por el JIT vs. intérprete (simd.js, ya validado contra Unicorn): mismos resultados bit a bit.
import { Emulator } from '../../src/emulator.js';
import { compileBlock } from '../../src/jit.js';
const OPS = [0x71, 0x72, 0x73, 0x6f, 0x7f, 0x6e, 0x7e, 0xfc, 0xfd, 0xfe, 0xf8, 0xf9, 0xfa, 0xec, 0xed, 0xe8, 0xe9, 0xdc, 0xdd, 0xd8, 0xd9, 0xd5, 0xe5, 0xe4, 0xdb, 0xdf, 0xeb, 0xef,
  0xf5, 0x74, 0x75, 0x76, 0x64, 0x65, 0x66, 0xda, 0xde, 0xea, 0xee, 0xe0, 0xe3, 0x63, 0x67, 0x6b, 0x60, 0x61, 0x62, 0x68, 0x69, 0x6a];
const emu = new Emulator({ log: () => {} }); const c = emu.cpu, m = emu.mem; const CODE = 0x500000, DATA = 0x600000;
let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
const special = [0, 0xffffffff, 0x7fff7fff, 0x80008000, 0x00ff00ff, 0x7f7f7f7f, 0x80808080, 0x12345678];
const val = () => (rnd() % 4 === 0 ? special[rnd() % special.length] : rnd());
let fails = 0, total = 0;
function state() { return [...new Uint32Array(c.simd.mbuf)].concat([m.r32(DATA), m.r32(DATA + 4)], [...c.r]); }
for (const op of OPS) for (let t = 0; t < 300; t++) {
  const regs = Array.from({ length: 16 }, val), mem = [val(), val()], gpr = Array.from({ length: 8 }, val); gpr[4] = 0x3fff0000;
  const reg = rnd() & 7, rmr = rnd() & 7, useMem = (rnd() & 1) === 1; const bytes = [0x0f, op];
  if (useMem) bytes.push((reg << 3) | 5, DATA & 255, (DATA >> 8) & 255, (DATA >> 16) & 255, DATA >>> 24); else bytes.push(0xc0 | (reg << 3) | (op === 0x6e || op === 0x7e ? (rmr === 4 ? 0 : rmr) : rmr));
  if (op === 0x71 || op === 0x72 || op === 0x73) { bytes.length = 2; bytes.push(0xc0 | ([2, 4, 6][rnd() % 3] << 3) | rmr, [0, 1, 7, 8, 15, 16, 31, 32, 33, 63, 64, 200][rnd() % 12]); if (op === 0x73 && ((bytes[2] >> 3) & 7) === 4) bytes[2] = (bytes[2] & ~0x38) | (2 << 3); }
  bytes.push(0xeb, 0xfe);
  const res = [];
  for (const jit of [false, true]) {
    new Uint32Array(c.simd.mbuf).set(regs); m.w32(DATA, mem[0]); m.w32(DATA + 4, mem[1]); c.r.set(gpr);
    bytes.forEach((b, i) => { m.u8[CODE + i] = b; }); emu.jit.map.clear(); emu.jit.fast.fill(undefined);
    c.eip = CODE;
    if (jit) { const fn = compileBlock(emu, CODE); if (fn.fallbacks) { res.push('fallback'); continue; } fn(c, c.r, m); } else c.step();
    res.push(state().join(','));
  }
  total++; if (res[0] !== res[1]) { if (fails++ < 10) console.log('DIFERENCIA op 0F', op.toString(16), useMem ? 'mem' : 'reg', '\n int', res[0], '\n jit', res[1]); }
}
console.log(`MMX JIT vs intérprete: ${total - fails}/${total} idénticos`);
