// Ejecuta F1C_CMT.exe con el núcleo (Node). VFS sobre la carpeta del juego, solo lectura.
//   node tools/run-f1c.mjs "<carpeta del juego>" [maxInstr]
// Variables: SECS (tope de tiempo), SAVE=dir (instantánea al final), LOAD=dir (continuar una instantánea),
// MHZ (reloj virtual, 1000), TURBO (ms por lectura de QPC), TRACE_FROM, SWITCH_AT, OPH=1, CPU=mmx, --no-jit
import fs from 'node:fs';
import { patchConfig } from '../src/f1c-config.js';
import { Emulator } from '../src/emulator.js';
import { DiskVFS } from './disk-vfs.mjs';
import { save, restore } from './snapshot.mjs';
const GAME = process.argv[2]; const max = Number(process.argv[3] || 6e9); const noJit = process.argv.includes('--no-jit'); const E = process.env;
const log = (s) => { if (E.TRACE_FROM || (!s.startsWith('[API]') && !s.startsWith('[FS]'))) console.log(s); };
const host = { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: { play() {}, stop() {}, update() {}, setVolume() {}, setPan() {}, setRate() {} } };
const makeVfs = () => { const v = new DiskVFS(GAME); if (!E.OPH) { v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); } return v; };
let emu;
if (E.LOAD) { emu = restore(E.LOAD, makeVfs, { log, host }); console.log(`[F1C] instantánea ${E.LOAD} restaurada en instr=${emu.cpu.icount}`); }
else {
  emu = new Emulator({ log, host }); emu.vfs = makeVfs();
  emu.vfs.add('Config.ini', new TextEncoder().encode(patchConfig(fs.readFileSync(GAME + '/Config.ini', 'latin1'))));
}
if (E.REAL) { emu.clockMode = 'real'; }
emu.traceApis = false; emu.logFiles = false; emu.instrPerMs = Number(E.MHZ || 1000) * 1000; emu.qpcTurboMs = Number(E.TURBO ?? 0.02);
if (E.CPU === 'mmx') { emu.cpuFeatures = [2, 3, 8, 12]; emu.cpu.cpuidEdx = 0x1 | 0x10 | 0x20 | 0x100 | 0x8000 | (1 << 23); }
if (E.TRACE_FROM) { emu.traceFrom = Number(E.TRACE_FROM); emu.maxApiLog = 4000; }
if (noJit) emu.useJit = false;
if (!E.LOAD) emu.loadMain(new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe')), 'F1C_CMT.EXE');
const t0 = Date.now(), i0 = emu.cpu.icount; let res = { status: 'running' };
emu.onPresent = (d) => { if (E.PACE) { const until = performance.now() + Number(E.PACE); while (performance.now() < until); } if (d.frame <= 30 || d.frame % 50 === 0) console.log(`[FRAME] ${d.frame} instr=${emu.cpu.icount} t=${((Date.now() - t0) / 1000).toFixed(1)}s draws=${emu.d3d.stats.draws} texturas=${emu.d3d.stats.textures}`); };
const SW = Number(E.SWITCH_AT || 0); const DEADLINE = Date.now() + Number(E.SECS || 1e9) * 1000;
while (emu.cpu.icount < max && Date.now() < DEADLINE) {
  if (SW && emu.useJit && emu.cpu.icount >= SW) { emu.useJit = false; console.log('[F1C] JIT desactivado en instr=' + emu.cpu.icount); }
  res = emu.run(20_000_000);
  if (res.status !== 'running' && res.status !== 'yield') break;
}
const ms = Date.now() - t0;
console.log(`[F1C] estado=${res.status} instr=${emu.cpu.icount} (+${emu.cpu.icount - i0} en ${ms} ms -> ${((emu.cpu.icount - i0) / ms / 1000).toFixed(1)} MIPS); archivos leídos=${emu.vfs.opened.size}`);
if (emu.d3d) { const s = emu.d3d.stats; console.log('[D3D] stats', JSON.stringify(s)); console.log('[D3D] formatos de textura', JSON.stringify(emu.d3d.formats)); if (emu.d3d.device) console.log('[D3D] frames', emu.d3d.device.frame, 'renderstates distintos', emu.d3d.device.rs.size); }
if (emu.mss) console.log('[MSS] samples', emu.mss.samples.size, 'archivos', emu.mss.files || 0, 'streams', emu.mss.streams.size);
if (E.SAVE && (res.status === 'running' || res.status === 'yield')) { const t = Date.now(); const r = save(emu, E.SAVE); console.log(`[F1C] instantánea en ${E.SAVE}: ${r.pages} páginas, instr=${r.icount} (${Date.now() - t} ms)`); }
