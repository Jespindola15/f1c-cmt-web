// main.js — página: crea el worker del emulador, le pasa el lienzo y reenvía teclado y ratón.
import { keyFor } from './keymap.js';
const $ = (id) => document.getElementById(id);
const canvas = $('screen'), status = $('status'), stats = $('stats'), logEl = $('log');
const params = new URLSearchParams(location.search); const snap = params.get('snap') || 'menu';
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const off = canvas.transferControlToOffscreen();
let W = 800, H = 600;
worker.postMessage({ type: 'start', canvas: off, snap }, [off]);
const addLog = (t) => { const d = document.createElement('div'); d.textContent = t; logEl.append(d); while (logEl.childNodes.length > 200) logEl.firstChild.remove(); logEl.scrollTop = 1e9; };
window.f1c = { worker, lastStats: null, halted: null, ready: false, logs: [] };
worker.onmessage = (ev) => { const m = ev.data;
  if (m.type === 'status') { status.textContent = m.text; status.hidden = !m.text; }
  else if (m.type === 'progress') { status.hidden = false; status.textContent = `Descargando ${m.label}: ${(m.got / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)} MB`; }
  else if (m.type === 'ready') { W = m.w; H = m.h; window.f1c.ready = true; canvas.focus(); }
  else if (m.type === 'title') document.title = m.text + ' — F1C CMT Web';
  else if (m.type === 'log') { window.f1c.logs.push(m.text); addLog(m.text); }
  else if (m.type === 'stats') { window.f1c.lastStats = m; stats.textContent = `${m.mips.toFixed(1)} MIPS · ${m.fps.toFixed(1)} fps · ${m.files} archivos`; }
  else if (m.type === 'halt') { window.f1c.halted = m.report; status.hidden = false; status.textContent = 'El emulador se detuvo (ver registro)'; addLog(m.report); }
  else if (m.type === 'shot') window.f1c.shot = m.blob;
  else if (m.type === 'probe') window.f1c.probe = m.data;
};
const pos = (e) => { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(W - 1, Math.round((e.clientX - r.left) / r.width * W))), Math.max(0, Math.min(H - 1, Math.round((e.clientY - r.top) / r.height * H)))]; };
const btn = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);
canvas.addEventListener('mousemove', (e) => { const [x, y] = pos(e); worker.postMessage({ type: 'mouse', x, y, button: 0, down: null }); });
canvas.addEventListener('mousedown', (e) => { canvas.focus(); const [x, y] = pos(e); worker.postMessage({ type: 'mouse', x, y, button: btn(e.button), down: true }); e.preventDefault(); });
canvas.addEventListener('mouseup', (e) => { const [x, y] = pos(e); worker.postMessage({ type: 'mouse', x, y, button: btn(e.button), down: false }); e.preventDefault(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const key = (down) => (e) => { const k = keyFor(e.code); if (!k) return; e.preventDefault(); if (down && e.repeat) return; worker.postMessage({ type: 'key', k, down }); };
canvas.addEventListener('keydown', key(true)); canvas.addEventListener('keyup', key(false));
$('full').onclick = () => canvas.requestFullscreen?.();
