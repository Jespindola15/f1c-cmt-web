// worker.js — ejecuta F1C_CMT.exe (x86 emulado) en un Web Worker; dibuja con WebGL2 en un OffscreenCanvas.
import { restore } from '../src/snapshot.js';
import { GameVFS } from '../src/vfs-core.js';
import { Emulator } from '../src/emulator.js';
import { patchConfig } from '../src/f1c-config.js';
import { installAccel } from '../src/accel.js';
import { GLBackend } from './gl-backend.js';
let emu = null, gl = null, running = false, lastStat = 0, frames = 0, instr0 = 0, t0 = 0;
const post = (type, data = {}) => self.postMessage({ type, ...data });
const log = (s) => { if (s.startsWith('[API]') || s.startsWith('[FS]')) return; post('log', { text: s }); };
async function fetchBin(url, label) {
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get('Content-Length')) || 0; const out = total ? new Uint8Array(total) : null; const parts = []; let got = 0;
  const rd = r.body.getReader(); let lastP = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; if (out) out.set(value, got); else parts.push(value); got += value.length;
    const now = performance.now(); if (now - lastP > 200) { lastP = now; post('progress', { label, got, total }); } }
  post('progress', { label, got, total: got });
  if (out) return out; const b = new Uint8Array(got); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; } return b;
}
// Origen de los archivos del juego: 'pack' (copia importada en OPFS, el modo de los jugadores), 'remote' (servidor
// con autorización para distribuir los archivos: lectura síncrona por XHR desde el worker) o 'snap' (diagnóstico).
async function makeVfs(source) {
  if (source.kind === 'remote') {
    const man = await (await fetch(source.base + 'manifest.json')).json();
    const entries = man.files.map(([path, size]) => ({ path, size }));
    const read = (e) => { const x = new XMLHttpRequest(); x.open('GET', source.base + e.path.split(/[\\/]/).map(encodeURIComponent).join('/'), false); x.responseType = 'arraybuffer'; x.send(); return x.status === 200 ? new Uint8Array(x.response) : null; };
    return new GameVFS({ entries, dirs: man.dirs, source: { read } });
  }
  const P = await import('./pack.js');
  const idx = await P.readIndex(); if (!idx) throw new Error('No hay archivos importados');
  const src = await P.openPacks(idx);
  const vfs = new GameVFS({ entries: idx.files.map(([path, size, pack, offset]) => ({ path, size, pack, offset })), dirs: idx.dirs, source: src, onWrite: P.saveUserFile, onDelete: P.deleteUserFile });
  let n = 0; for (const [k, data] of await P.loadUserFiles()) { vfs.files.set(k, { name: k.split('\\').pop(), data, written: true }); const i = k.lastIndexOf('\\'); if (i > 0) vfs.addDir(k.slice(0, i)); n++; }
  post('log', { text: `[VFS] ${idx.files.length} archivos del juego (${(idx.bytes / 1073741824).toFixed(2)} GB), ${n} archivos guardados por el juego` });
  return vfs;
}
async function start({ canvas, snap, opts = {}, source = { kind: 'pack' } }) {
  const host = { deferPresent: true, present() {}, setMode() {}, setTitle: (t) => post('title', { text: t }), messageBox: (c, t) => post('log', { text: `[MSGBOX] ${t}: ${c}` }) };
  if (snap) { await startSnap({ canvas, snap, opts, host }); return; }
  post('status', { text: 'Abriendo los archivos del juego…' });
  const vfs = await makeVfs(source);
  for (const k of ['OPH.DLL', 'VFXDRIVE.DLL']) vfs.index.delete(k); // capas del mod sin soporte todavía (el juego sigue sin ellas)
  const cfg = vfs.find('Config.ini'); if (!cfg) throw new Error('Falta Config.ini en la instalación');
  vfs.add('Config.ini', new TextEncoder().encode(patchConfig(new TextDecoder('latin1').decode(cfg.data))));
  const exe = vfs.find('F1C_CMT.exe'); if (!exe) throw new Error('Falta F1C_CMT.exe');
  emu = new Emulator({ log, host }); emu.vfs = vfs; emu.traceApis = false; emu.logFiles = false;
  emu.clockMode = 'real'; emu.qpcTurboMs = 0; emu.keys = new Uint8Array(256);
  emu.loadMain(exe.data, 'F1C_CMT.EXE');
  await finishStart(canvas, opts);
}
async function finishStart(canvas, opts) {
  gl = new GLBackend(canvas, emu); emu.d3dBackend = gl; gl.noDraw = !!opts.nodraw;
  post('log', { text: '[ACCEL] ' + installAccel(emu).join(', ') });
  const dev = emu.d3d?.device; if (dev) { gl.size(dev.backbuffer.w, dev.backbuffer.h); for (const o of emu.d3d.objs.values()) if (o.kind === 'texture') o.dirty = true; }
  emu.onPresent = () => { frames++; emu.yieldRequested = true; if (!shown) { shown = true; post('status', { text: '' }); post('firstFrame', {}); } };
  post('ready', { w: dev?.backbuffer.w || 1024, h: dev?.backbuffer.h || 768 });
  running = true; t0 = performance.now(); instr0 = emu.cpu.icount; loop();
}
let shown = false;
async function startSnap({ canvas, snap, opts, host }) {
  post('status', { text: 'Leyendo índice de archivos del juego…' });
  const manifest = await (await fetch('/game/manifest.json')).json();
  const state = await fetchBin(`/snap/${snap}/state.bin`, 'estado');
  const idx = await fetch(`/snap/${snap}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const mem = idx ? [] : await fetchBin(`/snap/${snap}/mem.bin`, 'memoria');
  post('status', { text: 'Restaurando la máquina x86…' });
  const read = (e) => { const x = new XMLHttpRequest(); x.open('GET', '/game/' + e.path.split(/[\\/]/).map(encodeURIComponent).join('/'), false); x.responseType = 'arraybuffer'; x.send(); return x.status === 200 ? new Uint8Array(x.response) : null; };
  emu = restore({ state, mem }, () => new GameVFS({ entries: manifest.files.map(([path, size]) => ({ path: path.replace(/\//g, '\\'), size })), dirs: manifest.dirs, source: { read } }), { log, host });
  emu.traceApis = false; emu.logFiles = false;
  if (idx) for (let i = 0; i < idx.chunks; i++) {
    post('progress', { label: `memoria ${i + 1}/${idx.chunks}`, got: i, total: idx.chunks });
    const r = await fetch(`/snap/${snap}/mem.${String(i).padStart(3, '0')}.z`);
    const ch = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const dv = new DataView(ch.buffer); for (let o = 0; o < ch.length; o += 4100) emu.mem.u8.set(ch.subarray(o + 4, o + 4100), dv.getUint32(o, true));
  }
  // Pasa del reloj virtual (el de las pruebas en Node) al reloj real sin saltos hacia atrás.
  const vnow = emu.nowMs(); emu.clockMode = 'real'; emu.timeOffset = vnow - performance.now(); emu.qpcTurboMs = 0;
  emu.keys = new Uint8Array(256);
  await finishStart(canvas, opts);
}
let frameWork = 0;
function loop() {
  if (!running) return;
  const t0w = performance.now(); const tEnd = t0w + 30; let res, presented = false;
  try {
    while (performance.now() < tEnd) {
      if (emu.waitUntil && emu.nowMs() < emu.waitUntil) break;
      res = emu.run(2_000_000);
      if (res.status === 'yield' && frames) { frames = 0; presented = true; break; }
      if (res.status !== 'running' && res.status !== 'yield') { running = false; post('halt', { report: res.report || res.status }); return; }
    }
  } catch (e) { running = false; post('halt', { report: String(e.stack || e) }); return; }
  const now = performance.now(); frameWork += now - t0w;
  if (!shown && now - lastBoot > 400) { lastBoot = now; post('boot', { instr: emu.cpu.icount, files: emu.vfs.opened.size }); }
  if (now - lastStat > 1000) { const dt = (now - t0) / 1000; const nf = Math.max(1, gl.stats.frames); const glMs = (gl.stats.drawMs || 0) + (gl.stats.presentMs || 0); gl.stats.drawMs = gl.stats.presentMs = 0;
    let heap = 0; for (const n of emu.mem.blocks.values()) heap += n;
    post('stats', { heapMB: Math.round(heap / 1048576), glMs: glMs / nf, emuMs: (statWork - glMs) / nf, mips: (emu.cpu.icount - instr0) / dt / 1e6, fps: gl.stats.frames / dt, draws: gl.stats.draws, tex: gl.stats.texUploads, skipped: gl.stats.skipped, files: emu.vfs.opened.size, icount: emu.cpu.icount });
    lastStat = now; t0 = now; instr0 = emu.cpu.icount; gl.stats.frames = 0; statWork = 0; }
  // A mitad de cuadro se sigue enseguida (MessageChannel = 0 ms). Tras un Present: si el cuadro costó menos
  // que un refresco se espera al vsync (no pasar de la frecuencia de la pantalla); si costó más, se sigue ya.
  if (!presented) { kick.port2.postMessage(0); return; }
  statWork += frameWork; const spent = frameWork; frameWork = 0;
  if (spent > 14 || !self.requestAnimationFrame) kick.port2.postMessage(0); else self.requestAnimationFrame(loop);
}
let statWork = 0, lastBoot = 0;
const kick = new MessageChannel(); kick.port1.onmessage = () => loop();
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'start') start(m).catch((e) => post('halt', { report: String(e.stack || e) }));
  else if (!emu) return;
  else if (m.type === 'key') { const [dik, vk] = m.k; emu.keys[dik] = m.down ? 1 : 0; (emu.state.diKeys ??= []).push([dik, m.down ? 0x80 : 0, Math.floor(emu.nowMs())]); emu.keyEvent(vk, m.down); }
  else if (m.type === 'mouse') emu.mouseEvent(m.x, m.y, m.button, m.down);
  else if (m.type === 'pause') running = false;
  else if (m.type === 'resume') { if (!running) { running = true; loop(); } }
  else if (m.type === 'probe') { gl.probe = []; const iv = setInterval(() => { if (gl.probe.length >= 2) { clearInterval(iv); post('probe', { data: JSON.stringify(gl.probe) }); } }, 100); }
  else if (m.type === 'shot') { const c = gl.canvas; c.convertToBlob({ type: 'image/png' }).then((b) => post('shot', { blob: b })); }
};
