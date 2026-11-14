// worker.js — ejecuta F1C_CMT.exe (x86 emulado) en un Web Worker; dibuja con WebGL2 en un OffscreenCanvas.
import { restore } from '../src/snapshot.js';
import { HttpVFS } from './vfs-http.js';
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
async function start({ canvas, snap }) {
  post('status', { text: 'Leyendo índice de archivos del juego…' });
  const manifest = await (await fetch('/game/manifest.json')).json();
  const state = await fetchBin(`/snap/${snap}/state.bin`, 'estado'); const mem = await fetchBin(`/snap/${snap}/mem.bin`, 'memoria');
  post('status', { text: 'Restaurando la máquina x86…' });
  const host = { deferPresent: true, present() {}, setMode() {}, setTitle: (t) => post('title', { text: t }), messageBox: (c, t) => post('log', { text: `[MSGBOX] ${t}: ${c}` }) };
  emu = restore({ state, mem }, () => new HttpVFS('/game/', manifest), { log, host });
  emu.traceApis = false; emu.logFiles = false;
  // Pasa del reloj virtual (el de las pruebas en Node) al reloj real sin saltos hacia atrás.
  const vnow = emu.nowMs(); emu.clockMode = 'real'; emu.timeOffset = vnow - performance.now(); emu.qpcTurboMs = 0;
  emu.keys = new Uint8Array(256);
  gl = new GLBackend(canvas, emu); emu.d3dBackend = gl; gl.timing = true;
  const dev = emu.d3d?.device; if (dev) { gl.size(dev.backbuffer.w, dev.backbuffer.h); for (const o of emu.d3d.objs.values()) if (o.kind === 'texture') o.dirty = true; }
  emu.onPresent = () => { frames++; emu.yieldRequested = true; };
  post('status', { text: '' }); post('ready', { w: dev?.backbuffer.w || 800, h: dev?.backbuffer.h || 600 });
  running = true; t0 = performance.now(); instr0 = emu.cpu.icount; loop();
}
function loop() {
  if (!running) return;
  const tEnd = performance.now() + 30; let res;
  try {
    while (performance.now() < tEnd) {
      if (emu.waitUntil && emu.nowMs() < emu.waitUntil) break;
      res = emu.run(2_000_000);
      if (res.status === 'yield' && frames) { frames = 0; break; }
      if (res.status !== 'running' && res.status !== 'yield') { running = false; post('halt', { report: res.report || res.status }); return; }
    }
  } catch (e) { running = false; post('halt', { report: String(e.stack || e) }); return; }
  const now = performance.now();
  if (now - lastStat > 1000) { const dt = (now - t0) / 1000; post('stats', { drawMs: gl.stats.drawMs, presentMs: gl.stats.presentMs, uploads: gl.stats.texUploads, mips: (emu.cpu.icount - instr0) / dt / 1e6, fps: gl.stats.frames / dt, draws: gl.stats.draws, tex: gl.stats.texUploads, skipped: gl.stats.skipped, files: emu.vfs.opened.size, icount: emu.cpu.icount });
    lastStat = now; t0 = now; instr0 = emu.cpu.icount; gl.stats.frames = 0; }
  if (self.requestAnimationFrame) self.requestAnimationFrame(loop); else setTimeout(loop, 0);
}
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
