// Ejecuta F1C_CMT.exe con el núcleo de Daytona + extensión F1C (VFS sobre disco, solo lectura).
import fs from 'node:fs';
import { Emulator } from '../src/emulator.js';
import { DiskVFS } from './disk-vfs.mjs';
const GAME = process.argv[2]; const max = Number(process.argv[3] || 6e9); const noJit = process.argv.includes('--no-jit');
const lines = []; const log = (s) => { lines.push(s); if (process.env.TRACE_FROM || (!s.startsWith('[API]') && !s.startsWith('[FS]'))) console.log(s); };
const emu = new Emulator({ log, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: { play() {}, stop() {}, update() {}, setVolume() {}, setPan() {}, setRate() {} } } });
emu.traceApis = false; emu.logFiles = false; emu.instrPerMs = Number(process.env.MHZ || 1000) * 1000; emu.qpcTurboMs = Number(process.env.TURBO ?? 0.02); if (process.env.CPU === 'mmx') { emu.cpuFeatures = [2, 3, 8, 12]; emu.cpu.cpuidEdx = 0x1 | 0x10 | 0x20 | 0x100 | 0x8000 | (1 << 23); } if (process.env.TRACE_FROM) { emu.traceFrom = Number(process.env.TRACE_FROM); emu.maxApiLog = 4000; } if (noJit) emu.useJit = false;
emu.vfs = new DiskVFS(GAME); if (!process.env.OPH) { emu.vfs.index.delete('OPH.DLL'); emu.vfs.index.delete('VFXDRIVE.DLL'); }
emu.vfs.files.set('CONFIG.INI', { name: 'Config.ini', data: new Uint8Array(fs.readFileSync(new URL('./config/Config.ini', import.meta.url))) });
emu.loadMain(new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe')), 'F1C_CMT.EXE');
emu.f1cT0 = Date.now(); let res; emu.onPresent = (d) => { if (d.frame <= 20 || d.frame % 50 === 0) console.log('[FRAME] ' + d.frame + ' instr=' + emu.cpu.icount + ' t=' + ((Date.now() - emu.f1cT0) / 1000).toFixed(1) + 's draws=' + emu.d3d.stats.draws + ' texturas=' + emu.d3d.stats.textures); };
const SW = Number(process.env.SWITCH_AT || 0); while (emu.cpu.icount < max) { if (SW && emu.useJit && emu.cpu.icount >= SW) { emu.useJit = false; console.log('[F1C] JIT desactivado en instr=' + emu.cpu.icount); } res = emu.run(20_000_000); if (res.status !== 'running') break; }
const ms = Date.now() - emu.f1cT0;
console.log(`[F1C] estado=${res.status} instr=${emu.cpu.icount} tiempo=${ms} ms -> ${(emu.cpu.icount / ms / 1000).toFixed(1)} MIPS; archivos leídos=${emu.vfs.opened.size}`);
console.log('[F1C] JIT', JSON.stringify(emu.jit?.stats || emu.blocks?.stats || {}));
if (emu.d3d) { const s = emu.d3d.stats; console.log('[D3D] stats', JSON.stringify(s)); console.log('[D3D] formatos de textura', JSON.stringify(emu.d3d.formats)); if (emu.d3d.device) console.log('[D3D] frames presentados', emu.d3d.device.frame, 'renderstates distintos', emu.d3d.device.rs.size); }
if (emu.mss) console.log('[MSS] samples', emu.mss.samples.size, 'cargados', emu.mss.loaded, 'streams', emu.mss.streams.size);
