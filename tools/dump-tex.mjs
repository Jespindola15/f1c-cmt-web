// Restaura una instantánea, corre unos frames y guarda cada textura (nivel 0) como PNG en tests/shots/.
import fs from 'node:fs';
import { restore } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
import { FMT } from '../src/win32/d3d8.js';
import { png } from './png.mjs';
const [GAME, SNAP, FRAMES, TAG] = [process.argv[2], process.argv[3], Number(process.argv[4] || 1), process.argv[5] || 'snap'];
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; emu.instrPerMs = 1e6; emu.qpcTurboMs = 0.02;
let frames = 0; emu.d3dBackend = { present() { frames++; } };
while (frames < FRAMES) { const r = emu.run(5_000_000); if (r.status !== 'running' && r.status !== 'yield') break; }
fs.mkdirSync(new URL('../tests/shots/', import.meta.url), { recursive: true });
const m = emu.mem;
for (const o of emu.d3d.objs.values()) {
  if (o.kind !== 'texture') continue; const s = o.surfaces[0]; if (![21, 22, 23].includes(s.fmt)) { console.log('omitida', o.id, FMT[s.fmt]); continue; }
  const rgba = new Uint8Array(s.w * s.h * 4);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const d = (y * s.w + x) * 4;
    if (s.fmt === 23) { const v = m.r16(s.mem + y * s.pitch + x * 2); rgba[d] = ((v >> 11) & 31) * 255 / 31; rgba[d + 1] = ((v >> 5) & 63) * 255 / 63; rgba[d + 2] = (v & 31) * 255 / 31; rgba[d + 3] = 255; }
    else { const p = s.mem + y * s.pitch + x * 4; rgba[d] = m.u8[p + 2]; rgba[d + 1] = m.u8[p + 1]; rgba[d + 2] = m.u8[p]; rgba[d + 3] = 255; }
  }
  const f = new URL(`../tests/shots/${TAG}_tex${o.id}_${s.w}x${s.h}.png`, import.meta.url).pathname; png({ w: s.w, h: s.h, rgba }, f); console.log('guardada', f);
}
