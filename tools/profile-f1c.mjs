// Muestreo: cada N instrucciones registra EIP y la última API, para ver dónde se va el tiempo.
import fs from 'node:fs';
import { Emulator } from '../src/emulator.js';
import { DiskVFS } from './disk-vfs.mjs';
const GAME = process.argv[2]; const max = Number(process.argv[3] || 3e9); const from = Number(process.argv[4] || 1e9);
const emu = new Emulator({ log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: { play() {}, stop() {}, update() {}, setVolume() {}, setPan() {}, setRate() {} } } });
emu.traceApis = false; emu.logFiles = false; emu.instrPerMs = 1e6; emu.qpcTurboMs = 0.02;
emu.vfs = new DiskVFS(GAME); emu.vfs.index.delete('OPH.DLL'); emu.vfs.index.delete('VFXDRIVE.DLL');
emu.vfs.files.set('CONFIG.INI', { name: 'Config.ini', data: new Uint8Array(fs.readFileSync(new URL('./config/Config.ini', import.meta.url))) });
emu.loadMain(new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe')), 'F1C_CMT.EXE');
const hist = new Map(); const apis = new Map(); let lastPresents = 0;
emu.onPresent = (d) => console.log(`[FRAME] ${d.frame} en instr=${emu.cpu.icount}`);
while (emu.cpu.icount < max) { const r = emu.run(Number(process.env.SLICE || 2_000_000)); if (r.status !== 'running') { console.log('estado', r.status); break; }
  if (emu.cpu.icount > from) { const k = process.env.EXACT ? emu.cpu.eip : (emu.cpu.eip >>> 8) << 8; hist.set(k, (hist.get(k) || 0) + 1); const t = emu.thunks?.length; } }
console.log('top regiones EIP (bloques de 256 bytes):'); [...hist].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, n]) => console.log('  0x' + k.toString(16), n));
