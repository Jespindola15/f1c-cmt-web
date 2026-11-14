// Banco de pruebas de rendimiento: restaura una instantánea, calienta el JIT y mide cuadros/s en estado estable.
//   node tools/bench-snap.mjs <juego> <instantánea> [calentamiento_instr] [segundos]
import { restore } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
const [GAME, SNAP, WARM = '600000000', SECS = '30'] = process.argv.slice(2);
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; if (process.env.NAMES) emu.jitNames = true; let frames = 0; emu.onPresent = () => frames++;
if (process.env.ACCEL !== '0') { const { installAccel } = await import('../src/accel.js').catch(() => ({})); if (installAccel) console.log('aceleradores:', installAccel(emu)); }
let t = Date.now(); emu.run(Number(WARM)); console.log(`calentamiento ${((Date.now() - t) / 1000).toFixed(1)}s`);
const f0 = frames, i0 = emu.cpu.icount; t = Date.now(); const end = t + Number(SECS) * 1000;
while (Date.now() < end) { const r = emu.run(5_000_000); if (r.status !== 'running' && r.status !== 'yield') { console.log(r.report?.text || r); break; } }
const ms = Date.now() - t, df = frames - f0, di = emu.cpu.icount - i0;
console.log(`cuadros=${df} cps=${(df / ms * 1000).toFixed(2)} instr/cuadro=${(di / df / 1e6).toFixed(2)}M MIPS=${(di / ms / 1000).toFixed(1)} jit=${JSON.stringify(emu.jit.stats)}`);
