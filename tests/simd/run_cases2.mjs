// Ejecuta los casos generados con Unicorn sobre el CPU JS y compara.
import fs from 'node:fs';
import { CPU } from '../../src/cpu.js';
import { Memory } from '../../src/memory.js';
const cases = JSON.parse(fs.readFileSync(new URL('./cases2.json', import.meta.url)));
const mem = new Memory(0x4000000); const cpu = new CPU(mem);
const CODE = 0x1000000, DATA = 0x2000000;
const hex = (u8) => Buffer.from(u8).toString('hex');
let ok = 0, bad = 0; const fails = new Map();
for (const k of cases) {
  const code = Buffer.from(k.code, 'hex'); mem.u8.set(code, CODE); mem.u8.set(Buffer.from(k.in.mem, 'hex'), DATA);
  k.in.gpr.forEach((v, i) => cpu.r[i] = v);
  for (let i = 0; i < 8; i++) { cpu.simd.xr(i).set(Buffer.from(k.in.xmm[i], 'hex')); cpu.simd.mr(i).set(Buffer.from(k.in.mm[i], 'hex')); }
  cpu.simd.mxcsr = k.in.mxcsr; cpu.eip = CODE;
  let err = null;
  try { cpu.step(); } catch (e) { err = e.message; }
  const diffs = [];
  if (err) diffs.push('ERROR ' + err);
  else {
    for (let i = 0; i < 8; i++) { if (hex(cpu.simd.xr(i)) !== k.out.xmm[i]) diffs.push(`xmm${i} ${hex(cpu.simd.xr(i))} != ${k.out.xmm[i]}`); if (hex(cpu.simd.mr(i)) !== k.out.mm[i]) diffs.push(`mm${i} ${hex(cpu.simd.mr(i))} != ${k.out.mm[i]}`); }
    for (let i = 0; i < 8; i++) if ((cpu.r[i] >>> 0) !== k.out.gpr[i]) diffs.push(`gpr${i} ${cpu.r[i].toString(16)} != ${k.out.gpr[i].toString(16)}`);
    if (hex(mem.u8.subarray(DATA, DATA + 64)) !== k.out.mem) diffs.push('mem');
    if (cpu.eip !== k.out.eip) diffs.push(`eip ${cpu.eip.toString(16)} != ${k.out.eip.toString(16)}`);
    if (k.flags) { const f = k.out.eflags; const want = [(f >> 6) & 1, (f >> 2) & 1, f & 1]; const got = [cpu.zf, cpu.pf, cpu.cf].map((x) => x ? 1 : 0);
      if (typeof cpu.getFlags === 'function') { const g = cpu.getFlags(); got[0] = (g >> 6) & 1; got[1] = (g >> 2) & 1; got[2] = g & 1; }
      if (want.join() !== got.join()) diffs.push(`ZPC ${got} != ${want}`); }
  }
  if (diffs.length) { bad++; (globalThis.rc ??= {})[(k.in.mxcsr >> 13) & 3] = ((globalThis.rc ?? {})[(k.in.mxcsr >> 13) & 3] || 0) + 1; const key = k.asm.split(' ')[0]; if (!fails.has(key)) fails.set(key, { asm: k.asm, diffs: diffs.slice(0, 3), n: 0 }); fails.get(key).n++; } else ok++;
}
console.log("fallos por modo de redondeo (0=nearest,1=down,2=up,3=trunc):", JSON.stringify(globalThis.rc));
console.log(`OK ${ok} / ${cases.length}   fallos ${bad}   instrucciones con fallas: ${fails.size}`);
for (const [m, f] of fails) console.log(` - ${m} (${f.n}): ${f.asm} :: ${f.diffs.join(' | ')}`);
