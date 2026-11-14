// Reproduce un cuadro capturado con tools/frame-capture.mjs usando el mismo GLBackend que el juego.
// /web/replay.html?cap=<nombre>&upto=<n operaciones>
import { GLBackend } from './gl-backend.js';
const q = new URLSearchParams(location.search); const cap = q.get('cap') || 'r9';
const rec = await (await fetch(`/cap/${cap}/frame.json`)).json();
const bin = new Uint8Array(await (await fetch(`/cap/${cap}/frame.bin`)).arrayBuffer());
const objs = new Map(); for (const o of rec.objs) objs.set(o.id, { ...o, dirty: true, addr: o.id, surfaces: o.surfaces.map((sf, i) => ({ ...sf, level: i })) });
const emu = { mem: { u8: bin }, d3d: { objs } };
const gl = new GLBackend(document.getElementById('c'), emu);
const rts = new Map(); const bb = { kind: 'backbuffer', w: 1024, h: 768 };
let id = 1e6; const upto = Number(q.get('upto') || rec.ops.length);
function mkDev(o) {
  const d = o.dev; bb.w = d.bb[0]; bb.h = d.bb[1];
  let rt = bb; if (d.rt !== 'bb' && d.rt.tex) { const k = d.rt.tex + ':' + d.rt.level; rt = rts.get(k); if (!rt) { const t = objs.get(d.rt.tex); rt = { kind: 'level', container: t, level: d.rt.level, w: d.rt.w, h: d.rt.h }; rts.set(k, rt); } }
  const dev = { vs: d.vs, rs: new Map(d.rs), tss: d.tss.map((x) => new Map(x)), xf: new Map(d.xf.map(([k, v]) => [k, new Float32Array(v)])), viewport: d.viewport, backbuffer: bb, tex: d.tex.concat(new Array(6).fill(0)), rt, baseIndex: 0, streams: [], indices: 0 };
  if (o.op === 'draw' && (o.kind === 'DP' || o.kind === 'DIP')) { const vb = id++; objs.set(vb, { kind: 'vb', mem: o.vb }); dev.streams[0] = { vb, stride: o.stride }; if (o.kind === 'DIP') { const ib = id++; objs.set(ib, { kind: 'ib', mem: o.ib, fmt: d.ifmt }); dev.indices = ib; } }
  return dev;
}
let n = 0; const t0 = performance.now();
for (const o of rec.ops) { if (n++ >= upto) break; if (o.op === 'rt') continue; const dev = mkDev(o);
  if (o.op === 'clear') gl.clear(dev, o.args[0], o.args[1], o.args[2], o.args[3]); else if (o.op === 'draw') gl.draw(dev, o.kind, o.a); }
gl.present(mkDev({ op: 'present', dev: rec.ops.find((o) => o.dev).dev }));
document.getElementById('s').textContent = `ops=${n} ms=${(performance.now() - t0).toFixed(0)} omitidos=${JSON.stringify(gl.stats.skipped)} draws=${gl.stats.draws}`;
window.replayDone = true;
