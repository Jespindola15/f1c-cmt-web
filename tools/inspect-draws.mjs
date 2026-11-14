// Restaura una instantánea, corre N frames y vuelca los parámetros de cada draw (vértices, FVF, texturas, estados).
import { restore } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
import { FMT } from '../src/win32/d3d8.js';
const [GAME, SNAP, FRAMES] = [process.argv[2], process.argv[3], Number(process.argv[4] || 2)];
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; emu.instrPerMs = 1e6; emu.qpcTurboMs = 0.02;
const m = emu.mem; let frames = 0;
const fvfSize = (f) => { let s = 0; const pos = f & 0x0e; s += pos === 2 ? 12 : pos === 4 ? 16 : pos >= 6 ? 12 + 4 * ((pos - 4) / 2) : 0; if (f & 0x10) s += 12; if (f & 0x20) s += 4; if (f & 0x40) s += 4; if (f & 0x80) s += 4; s += 8 * ((f >> 8) & 0xf); return s; };
emu.d3dBackend = { draw(dev, kind, a) {
  const st = dev.streams[0] || {}; const vb = st.vb ? emu.d3d.objs.get(st.vb) : null;
  const fvf = dev.vs < 0x10000 ? dev.vs : 'shader';
  console.log(`DRAW ${kind} tipo=${a.type} count=${a.count} start=${a.start ?? ''} FVF=0x${typeof fvf === 'number' ? fvf.toString(16) : fvf} stride=${st.stride} vb=${vb ? vb.len + 'B' : '-'}`);
  for (let s = 0; s < 2; s++) { const t = dev.tex[s] && emu.d3d.objs.get(dev.tex[s]); if (t) console.log(`   tex${s}: ${t.w}x${t.h} ${FMT[t.fmt]} niveles=${t.levels}`); }
  if (vb && typeof fvf === 'number') { const n = Math.min(6, (a.count + 2) * 1); for (let i = 0; i < n; i++) { const b = vb.mem + (a.start + i) * st.stride; const f = []; for (let k = 0; k < st.stride / 4; k++) f.push(Number.isFinite(m.dv.getFloat32(b + 4 * k, true)) && Math.abs(m.dv.getFloat32(b + 4 * k, true)) < 1e7 ? +m.dv.getFloat32(b + 4 * k, true).toFixed(3) : '0x' + m.r32(b + 4 * k).toString(16)); console.log('   v' + i, f.join(' ')); } }
  const rs = [...dev.rs].map(([k, v]) => k + '=' + v).join(' '); console.log('   RS', rs);
  const t0 = [...dev.tss[0]].map(([k, v]) => k + '=' + v).join(' '); console.log('   TSS0', t0);
}, present(dev) { frames++; } };
while (frames < FRAMES) { const r = emu.run(5_000_000); if (r.status !== 'running' && r.status !== 'yield') break; }
const dev = emu.d3d.device; console.log('viewport', dev.viewport, 'backbuffer', dev.backbuffer.w, dev.backbuffer.h, FMT[dev.backbuffer.fmt]);
console.log('texturas:'); for (const o of emu.d3d.objs.values()) if (o.kind === 'texture') console.log('  #' + o.id, o.w + 'x' + o.h, FMT[o.fmt], 'niveles', o.levels);
