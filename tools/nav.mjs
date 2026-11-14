// Navegación guionada del juego en Node (sin GPU): continúa una instantánea, inyecta ratón/teclado por cuadro y
// guarda capturas de la interfaz (la textura que el juego compone en software y dibuja como quad de pantalla).
//   node tools/nav.mjs <juego> <instantánea> "<guion>" [segundos] [salida_instantánea]
// guion: "30:click:978,732; 60:shot:nombre; 90:key:28,13" (cuadros relativos al inicio)
import fs from 'node:fs';
import { restore, save } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
import { installAccel } from '../src/accel.js';
import { png } from './png.mjs';
const [GAME, SNAP, SCRIPT = '', SECS = '120', OUT] = process.argv.slice(2);
const logs = []; const log = (s) => { if (!s.startsWith('[API]') && !s.startsWith('[FS]')) { console.log(s); } };
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; emu.keys = new Uint8Array(256); installAccel(emu);
if (process.env.REAL) { const v = emu.nowMs(); emu.clockMode = 'real'; emu.timeOffset = v - performance.now(); }
const steps = SCRIPT.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const [f, a, x] = s.split(':'); return { f: Number(f), a, x: x || '' }; });
let frame = 0, uiTex = 0; const t0 = Date.now(); const opened0 = new Set(emu.vfs.opened.keys());
emu.d3dBackend = { draw(dev, kind, a) { if (kind === 'DP' && dev.vs === 0x144 && dev.tex[0]) uiTex = dev.tex[0]; } };
function shot(name) {
  const o = emu.d3d.objs.get(uiTex); if (!o) { console.log('[SHOT] sin textura de interfaz'); return; }
  const s = o.surfaces[0], m = emu.mem.u8, W = Math.min(s.w, 1024), H = Math.min(s.h, 768); const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = s.mem + y * s.pitch + x * 4, d = (y * W + x) * 4; rgba[d] = m[p + 2]; rgba[d + 1] = m[p + 1]; rgba[d + 2] = m[p]; rgba[d + 3] = 255; }
  const f = new URL(`../tests/shots/nav_${name}.png`, import.meta.url).pathname; png({ w: W, h: H, rgba }, f); console.log('[SHOT]', f, `${s.w}x${s.h}`);
}
emu.onPresent = () => { frame++;
  for (const s of steps) if (s.f === frame) {
    const [a, b] = s.x.split(',').map(Number);
    if (s.a === 'move') emu.mouseEvent(a, b, 0, null);
    else if (s.a === 'click') { emu.mouseEvent(a, b, 0, null); emu.mouseEvent(a, b, 0, true); s.up = frame + 4; }
    else if (s.a === 'key' || s.a === 'keyup') { const down = s.a === 'key'; emu.keys[a] = down ? 1 : 0; (emu.state.diKeys ??= []).push([a, down ? 0x80 : 0, 0]); if (b) emu.keyEvent(b, down); }
    else if (s.a === 'shot') shot(s.x);
    console.log(`[ENTRADA] cuadro ${frame}: ${s.a} ${s.x}`);
  }
  for (const s of steps) if (s.up === frame) { const [a, b] = s.x.split(',').map(Number); emu.mouseEvent(a, b, 0, false); }
  if (frame % 100 === 0) console.log(`[FRAME] ${frame} instr=${emu.cpu.icount} t=${((Date.now() - t0) / 1000).toFixed(0)}s archivos=${emu.vfs.opened.size}`);
};
const end = Date.now() + Number(SECS) * 1000; let r;
while (Date.now() < end) { r = emu.run(10_000_000); if (r.status !== 'running' && r.status !== 'yield') { console.log(r.report?.text || r); break; } }
const newFiles = [...emu.vfs.opened.keys()].filter((k) => !opened0.has(k));
{ const m = emu.mem; m.ensureFree(); console.log(`[HEAP] tope=${((m.heapPtr - 0x03000000) / 1048576).toFixed(0)} MB, libres=${(m.freeBytes() / 1048576).toFixed(0)} MB, bloques vivos=${m.blocks.size}`); }
console.log(`[FIN] cuadros=${frame} instr=${emu.cpu.icount} archivos nuevos=${newFiles.length}: ${newFiles.slice(-25).join(' | ')}`);
if (process.env.LASTSHOT) shot(process.env.LASTSHOT);
if (OUT && (r.status === 'running' || r.status === 'yield')) console.log('[INSTANTÁNEA]', OUT, save(emu, OUT));
