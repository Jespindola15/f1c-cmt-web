// Captura de un cuadro de Direct3D 8 para reproducirlo en el navegador con el mismo backend WebGL2 (sin tener que
// cargar 2 GB de memoria emulada en Chrome). Restaura una instantánea, avanza N cuadros y graba el siguiente.
//   node tools/frame-capture.mjs <juego> <instantánea> <salida_dir> [cuadros_previos=2]
import fs from 'node:fs';
import path from 'node:path';
import { restore } from './snapshot.mjs';
import { DiskVFS } from './disk-vfs.mjs';
import { installAccel } from '../src/accel.js';
const [GAME, SNAP, OUT, SKIP = '2'] = process.argv.slice(2);
const emu = restore(SNAP, () => { const v = new DiskVFS(GAME); v.index.delete('OPH.DLL'); v.index.delete('VFXDRIVE.DLL'); return v; }, { log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: {} } });
emu.traceApis = false; installAccel(emu);
let frames = 0, rec = null; const N = Number(SKIP);
const buf = { data: new Uint8Array(64 << 20), n: 0 };
const put = (src) => { while (buf.n + src.length + 16 > buf.data.length) { const b = new Uint8Array(buf.data.length * 2); b.set(buf.data); buf.data = b; } const o = (buf.n + 15) & ~15; buf.data.set(src, o); buf.n = o + src.length; return o; };
const m = emu.mem.u8; const texMap = new Map(); let fakeSeq = 1;
function texId(id) {
  if (!id) return 0; if (texMap.has(id)) return texMap.get(id);
  const o = emu.d3d.objs.get(id); if (!o || o.kind !== 'texture') return 0;
  const f = fakeSeq++; rec.objs.push({ id: f, kind: 'texture', fmt: o.fmt, surfaces: o.surfaces.map((s) => ({ w: s.w, h: s.h, fmt: s.fmt, size: s.size, pitch: s.pitch, mem: put(m.subarray(s.mem, s.mem + s.size)) })) });
  texMap.set(id, f); return f;
}
const mapObj = (mp) => [...mp];
function devState(dev) { return { vs: dev.vs, rs: mapObj(dev.rs), tss: dev.tss.map(mapObj), xf: [...dev.xf].map(([k, v]) => [k, [...v]]), viewport: [...dev.viewport], bb: [dev.backbuffer.w, dev.backbuffer.h], tex: dev.tex.slice(0, 2).map(texId), rt: !dev.rt || dev.rt === dev.backbuffer ? 'bb' : dev.rt.container ? { tex: texId(dev.rt.container.addr), level: dev.rt.level || 0, w: dev.rt.w, h: dev.rt.h } : { w: dev.rt.w, h: dev.rt.h, kind: dev.rt.kind } }; }
function vcount(type, n) { return type === 1 ? n : type === 2 ? n * 2 : type === 3 ? n + 1 : type === 4 ? n * 3 : (type === 5 || type === 6) ? n + 2 : 0; }
emu.d3dBackend = {
  clear(dev, fl, color, z, stencil) { if (rec) rec.ops.push({ op: 'clear', dev: devState(dev), args: [fl, color >>> 0, z, stencil] }); },
  draw(dev, kind, a) {
    if (!rec) return; const nv = vcount(a.type, a.count); const st = devState(dev); const A = { ...a }; let vb = 0, ib = 0, stride = 0;
    if (kind === 'DP' || kind === 'DIP') { const s = dev.streams[0]; const vbo = s && emu.d3d.objs.get(s.vb); if (!vbo) return; stride = s.stride;
      if (kind === 'DP') { vb = put(m.subarray(vbo.mem + a.start * stride, vbo.mem + (a.start + nv) * stride)); A.start = 0; }
      else { const ibo = emu.d3d.objs.get(dev.indices); if (!ibo) return; const isz = ibo.fmt === 102 ? 4 : 2; const base = dev.baseIndex;
        vb = put(m.subarray(vbo.mem + (base + a.minIdx) * stride, vbo.mem + (base + a.minIdx + a.numV) * stride));
        const raw = m.slice(ibo.mem + a.startIdx * isz, ibo.mem + (a.startIdx + nv) * isz); const I = isz === 4 ? new Uint32Array(raw.buffer) : new Uint16Array(raw.buffer);
        for (let i = 0; i < I.length; i++) I[i] -= a.minIdx; ib = put(new Uint8Array(I.buffer)); A.startIdx = 0; A.minIdx = 0; st.ifmt = ibo.fmt; } }
    else if (kind === 'DPUP') { A.data = put(m.subarray(a.data, a.data + nv * a.stride)); }
    else { const isz = a.ifmt === 102 ? 4 : 2; A.data = put(m.subarray(a.data + a.minIdx * a.stride, a.data + (a.minIdx + a.numV) * a.stride)); const raw = m.slice(a.idx, a.idx + nv * isz); const I = isz === 4 ? new Uint32Array(raw.buffer) : new Uint16Array(raw.buffer); for (let i = 0; i < I.length; i++) I[i] -= a.minIdx; A.idx = put(new Uint8Array(I.buffer)); A.minIdx = 0; }
    rec.ops.push({ op: 'draw', kind, a: A, dev: st, vb, ib, stride });
  },
  setRenderTarget(dev) { if (rec) rec.ops.push({ op: 'rt', rt: dev.rt === dev.backbuffer ? 'bb' : dev.rt ? `${dev.rt.kind}:${dev.rt.w}x${dev.rt.h}` : 'null' }); },
};
emu.onPresent = () => { frames++; if (frames === N) rec = { ops: [], objs: [] }; else if (rec && frames === N + 1) { emu.stopCapture = true; emu.yieldRequested = true; } };
while (!emu.stopCapture) { const r = emu.run(5e6); if (r.status !== 'running' && r.status !== 'yield') { console.log(r.report?.text || r); break; } }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'frame.json'), JSON.stringify(rec)); fs.writeFileSync(path.join(OUT, 'frame.bin'), buf.data.subarray(0, buf.n));
const kinds = {}; for (const o of rec.ops) kinds[o.op + (o.kind ? ':' + o.kind : '')] = (kinds[o.op + (o.kind ? ':' + o.kind : '')] || 0) + 1;
const fvfs = {}; for (const o of rec.ops) if (o.op === 'draw') fvfs[o.dev.vs.toString(16)] = (fvfs[o.dev.vs.toString(16)] || 0) + 1;
console.log('ops', JSON.stringify(kinds), 'fvf', JSON.stringify(fvfs), 'texturas', rec.objs.length, 'bytes', buf.n, 'rt', JSON.stringify([...new Set(rec.ops.map((o) => JSON.stringify(o.dev?.rt || o.rt)))]));
