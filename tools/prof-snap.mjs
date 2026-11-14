// Perfil por muestreo sobre una instantánea: EIP cada N instrucciones; agrupa por bloque de 64 bytes y
// atribuye a la función llamante (dirección de retorno en la pila para código en DLLs/rutinas cortas).
import { restore } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
const [GAME, SNAP, WARM = '400000000', SAMPLES_I = '20000', SECS = '60'] = process.argv.slice(2);
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; let frames = 0; emu.onPresent = () => frames++;
emu.run(Number(WARM)); const f0 = frames, i0 = emu.cpu.icount, t0 = Date.now();
const H = new Map(); let n = 0; const end = Date.now() + Number(SECS) * 1000;
while (Date.now() < end) { emu.run(Number(SAMPLES_I)); const k = emu.cpu.eip >>> 6 << 6; H.set(k, (H.get(k) || 0) + 1); n++; }
const df = frames - f0, di = emu.cpu.icount - i0;
console.log(`cuadros=${df} instr/cuadro=${(di / df / 1e6).toFixed(2)}M MIPS=${(di / (Date.now() - t0) / 1000).toFixed(1)} muestras=${n}`);
console.log([...H].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k.toString(16)} ${(100 * v / n).toFixed(1)}%`).join('\n'));
