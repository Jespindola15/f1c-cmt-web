// Continúa una instantánea en Node inyectando entrada por cuadro y guarda otra instantánea al final.
//   node tools/input-run.mjs <juego> <instantánea> "<guion>" [segundos] [salida]
// guion: "10:move:978,732; 12:down:978,732; 16:up:978,732; 30:key:28" (cuadro:acción:args, relativo al inicio)
import { restore, save } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
const [GAME, SNAP, SCRIPT = '', SECS = '120', OUT] = process.argv.slice(2);
const log = (s) => { if (!s.startsWith('[API]') && !s.startsWith('[FS]')) console.log(s); };
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; emu.keys = new Uint8Array(256);
const steps = SCRIPT.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const [f, a, x] = s.split(':'); return { f: Number(f), a, x: (x || '').split(',').map(Number) }; });
let frame = 0; const t0 = Date.now(); const draws = {};
emu.d3dBackend = { draw(dev, kind, a) { draws[kind] = (draws[kind] || 0) + 1; } };
emu.onPresent = (d) => { frame++;
  for (const s of steps) if (s.f === frame) { console.log(`[ENTRADA] cuadro ${frame}: ${s.a} ${s.x}`);
    if (s.a === 'move') emu.mouseEvent(s.x[0], s.x[1], 0, null); else if (s.a === 'down') emu.mouseEvent(s.x[0], s.x[1], 0, true); else if (s.a === 'up') emu.mouseEvent(s.x[0], s.x[1], 0, false);
    else if (s.a === 'key' || s.a === 'keyup') { const down = s.a === 'key'; emu.keys[s.x[0]] = down ? 1 : 0; (emu.state.diKeys ??= []).push([s.x[0], down ? 0x80 : 0, 0]); if (s.x[1]) emu.keyEvent(s.x[1], down); } }
  if (frame % 100 === 0 || frame < 3) console.log(`[FRAME] ${frame} instr=${emu.cpu.icount} t=${((Date.now() - t0) / 1000).toFixed(0)}s draws=${JSON.stringify(draws)} texturas=${emu.d3d.stats.textures} archivos=${emu.vfs.opened.size}`); };
const end = Date.now() + Number(SECS) * 1000; let r;
const prof = process.env.PROF ? new Map() : null; const api0 = new Map(emu.apiCounts);
while (Date.now() < end) { r = emu.run(prof ? 200_000 : 10_000_000); if (prof) { const k = emu.cpu.eip >>> 4 << 4; prof.set(k, (prof.get(k) || 0) + 1); } if (r.status !== 'running' && r.status !== 'yield') { console.log(r.report?.text || r); break; } }
if (prof) { console.log("[PERFIL]", [...prof].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => k.toString(16) + ":" + v).join(" ")); console.log("[APIS]", [...emu.apiCounts].map(([k, v]) => [k, v - (api0.get(k) || 0)]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 15).map((x) => x.join("=")).join(" ")); }
console.log("[ARCHIVOS]", [...emu.vfs.opened.keys()].slice(-12).join(" | ")); console.log(`[FIN] cuadros=${frame} instr=${emu.cpu.icount} draws=${JSON.stringify(draws)} stats=${JSON.stringify(emu.d3d.stats)}`);
if (OUT && (r.status === 'running' || r.status === 'yield')) { const s = save(emu, OUT); console.log('[INSTANTÁNEA]', OUT, s); }
