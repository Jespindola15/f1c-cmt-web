// Equivalencia del JIT optimizado: misma instantánea, mismo número de instrucciones, con y sin la opción
// a comparar (por defecto: expansión en línea). Compara registros, FPU, MMX/XMM y un hash de toda la memoria.
//   node tests/jit_equiv.mjs <juego> <instantánea> [instrucciones] [opción: inline|accel]
import { restore } from '../tools/snapshot.mjs';
import { DiskVFS } from '../tools/disk-vfs.mjs';
const [GAME, SNAP, N = '200000000', WHAT = 'inline'] = process.argv.slice(2);
let target = 0;
async function go(variant) {
  const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {} });
  emu.traceApis = false; emu.qpcTurboMs = 0;
  if (WHAT === 'inline') emu.noInline = !variant;
  if (WHAT === 'regions') emu.useRegions = variant;
  if (WHAT === 'rflags') emu.regionFlags = variant;
  if (WHAT === 'regs') emu.cacheRegs = variant;
  if (WHAT === 'jit') emu.useJit = variant;
  if (WHAT === 'accel' && variant) { const { installAccel } = await import('../src/accel.js'); installAccel(emu); }
  const t = Date.now(); const end = target || emu.cpu.icount + Number(N); while (emu.cpu.icount < end) { const r = emu.run(Math.min(5e6, end - emu.cpu.icount)); if (r.status !== 'running' && r.status !== 'yield') { console.log(r.report?.text); break; } }
  const c = emu.cpu, u = emu.mem.u32; let h = 0; for (let i = 0; i < u.length; i++) h = (Math.imul(h, 31) + u[i]) | 0;
  const st = { icount: c.icount, eip: c.eip.toString(16), r: [...c.r].map((x) => x.toString(16)).join(' '), fpu: [...c.fpu.st].join(','), top: c.fpu.top, mm: [...new Uint32Array(c.simd.mbuf)].join(','), xmm: [...new Uint32Array(c.simd.xbuf)].join(','), mem: h >>> 0 };
  console.log(variant ? 'con   ' : 'sin   ', `${((Date.now() - t) / 1000).toFixed(1)}s`, st.icount, st.eip, st.mem.toString(16)); return st;
}
let a, b;
if (WHAT === 'jit') { b = await go(true); target = b.icount; a = await go(false); } else { a = await go(false); b = await go(true); }
const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
console.log(diff.length ? `DIFERENCIAS (${WHAT}): ${diff.join(', ')}\n${diff.map((k) => `  ${k}: ${a[k]} | ${b[k]}`).join('\n')}` : `IDÉNTICO (${WHAT})`);
