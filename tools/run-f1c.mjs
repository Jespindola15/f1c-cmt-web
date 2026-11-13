// Ejecuta F1C_CMT.exe con el núcleo de Daytona + extensión F1C (VFS sobre disco, solo lectura).
import fs from 'node:fs';
import { Emulator } from '../src/emulator.js';
import { DiskVFS } from '../src/win32/f1c.js';
const GAME = process.argv[2]; const max = Number(process.argv[3] || 6e9); const noJit = process.argv.includes('--no-jit');
const lines = []; const log = (s) => { lines.push(s); if (process.env.TRACE_FROM || (!s.startsWith('[API]') && !s.startsWith('[FS]'))) console.log(s); };
const emu = new Emulator({ log, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: { play() {}, stop() {}, update() {}, setVolume() {}, setPan() {}, setRate() {} } } });
emu.traceApis = false; emu.logFiles = false; if (process.env.TRACE_FROM) { emu.traceFrom = Number(process.env.TRACE_FROM); emu.maxApiLog = 4000; } if (noJit) emu.useJit = false;
emu.vfs = new DiskVFS(GAME); if (!process.env.OPH) { emu.vfs.index.delete('OPH.DLL'); emu.vfs.index.delete('VFXDRIVE.DLL'); }
emu.vfs.files.set('CONFIG.INI', { name: 'Config.ini', data: new Uint8Array(fs.readFileSync(new URL('./config/Config.ini', import.meta.url))) });
emu.loadMain(new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe')), 'F1C_CMT.EXE');
emu.f1cT0 = Date.now(); let res;
while (emu.cpu.icount < max) { res = emu.run(20_000_000); if (res.status !== 'running') break; }
const ms = Date.now() - emu.f1cT0;
console.log(`[F1C] estado=${res.status} instr=${emu.cpu.icount} tiempo=${ms} ms -> ${(emu.cpu.icount / ms / 1000).toFixed(1)} MIPS; archivos leídos=${emu.vfs.opened.size}`);
console.log('[F1C] JIT', JSON.stringify(emu.jit?.stats || emu.blocks?.stats || {}));
