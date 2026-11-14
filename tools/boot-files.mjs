// Determina el grupo "arranque" del manifiesto: archivos que el juego abre desde el inicio hasta el menú principal.
// 1) desde cero hasta la pantalla legal (reloj virtual), 2) clic en aceptar y carga del menú principal.
//   node tools/boot-files.mjs <juego> <salida.json>
import fs from 'node:fs';
import { Emulator } from '../src/emulator.js';
import { DiskVFS } from './disk-vfs.mjs';
import { patchConfig } from '../src/f1c-config.js';
import { installAccel } from '../src/accel.js';
const [GAME, OUT] = process.argv.slice(2);
const emu = new Emulator({ log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.vfs = new DiskVFS(GAME); for (const k of ['OPH.DLL', 'VFXDRIVE.DLL']) emu.vfs.index.delete(k);
emu.vfs.add('Config.ini', new TextEncoder().encode(patchConfig(fs.readFileSync(GAME + '/Config.ini', 'latin1'))));
emu.traceApis = false; emu.instrPerMs = 1e6; emu.qpcTurboMs = 0.02; emu.keys = new Uint8Array(256);
emu.loadMain(new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe')), 'F1C_CMT.EXE'); installAccel(emu);
const seen = new Set(['F1C_CMT.EXE', 'CONFIG.INI']); const orig = emu.vfs.find.bind(emu.vfs);
emu.vfs.find = (p) => { const f = orig(p); if (f) seen.add(emu.vfs.norm(p)); return f; };
let frames = 0, clickAt = 0, phase = 'legal'; const t0 = Date.now();
emu.onPresent = () => { frames++;
  if (phase === 'legal' && emu.cpu.icount > 9.75e9 && !clickAt) { clickAt = frames; emu.mouseEvent(978, 732, 0, null); emu.mouseEvent(978, 732, 0, true); }
  if (clickAt && frames === clickAt + 6) { emu.mouseEvent(978, 732, 0, false); phase = 'menu'; }
};
while (Date.now() - t0 < 170000) { const r = emu.run(20e6); if (r.status !== 'running' && r.status !== 'yield') { console.log(r.report?.text || r); break; }
  if (phase === 'menu' && emu.d3d?.stats.drawsByKind?.DIP > 2000) break; }
const list = [...seen].filter((k) => emu.vfs.index.has(k)).map((k) => emu.vfs.index.get(k).path).sort();
fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
console.log(`arranque: ${list.length} archivos, ${(list.reduce((a, p) => a + emu.vfs.index.get(emu.vfs.key(p)).size, 0) / 1048576).toFixed(0)} MB, instr=${emu.cpu.icount}, fase=${phase}, DIP=${emu.d3d?.stats.drawsByKind?.DIP}`);
