// Registra el color difuso del primer vértice de cada draw (para estudiar fundidos) al continuar una instantánea.
import { restore } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
const [GAME, SNAP, SECS = '40', MODE = 'virtual'] = process.argv.slice(2);
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {} });
emu.traceApis = false; if (MODE === 'real') { const v = emu.nowMs(); emu.clockMode = 'real'; emu.timeOffset = v - performance.now(); emu.qpcTurboMs = 0; }
let n = 0; emu.d3dBackend = { draw(dev, kind, a) { if (n++ % 40) return; const s = dev.streams[0]; const vb = emu.d3d.objs.get(s.vb); const d = emu.mem.r32(vb.mem + a.start * s.stride + 16);
  console.log(`frame ${dev.frame} t=${emu.nowMs().toFixed(0)} diffuse=${d.toString(16)} tex=${dev.tex[0]} draws/frame?`); } };
const end = Date.now() + Number(SECS) * 1000; while (Date.now() < end) { const r = emu.run(5e6); if (r.status !== 'running' && r.status !== 'yield') { console.log(r); break; } }
console.log('instr', emu.cpu.icount, 'frames', emu.d3d.device.frame);
