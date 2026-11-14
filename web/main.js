// main.js — lanzador: importa (una sola vez) la instalación del jugador al almacenamiento privado del navegador,
// arranca el emulador en un worker con el lienzo y reenvía teclado y ratón. Sin archivos del juego en el servidor.
import { keyFor } from './keymap.js';
import { readIndex, clearPack } from './pack.js';
const $ = (id) => document.getElementById(id);
const canvas = $('screen'), stats = $('stats'), logEl = $('log');
const params = new URLSearchParams(location.search);
const addLog = (t) => { const d = document.createElement('div'); d.textContent = t; logEl.append(d); while (logEl.childNodes.length > 300) logEl.firstChild.remove(); logEl.scrollTop = 1e9; };
window.f1c = { worker: null, lastStats: null, halted: null, ready: false, logs: [] };
const panel = { show(title, msg = '') { $('panel').hidden = false; $('ptitle').textContent = title; $('pmsg').textContent = msg; $('pbtns').replaceChildren(); $('pbar').hidden = true; $('ptext').textContent = ''; },
  hide() { $('panel').hidden = true; }, progress(v, text) { $('pbar').hidden = false; $('pbar').value = v; $('ptext').textContent = text; },
  button(label, fn, cls) { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; $('pbtns').append(b); return b; } };
const GB = (b) => (b / 1073741824).toFixed(2) + ' GB';

function checkSupport() {
  const miss = [];
  if (typeof WebAssembly !== 'object') miss.push('WebAssembly');
  if (!navigator.storage?.getDirectory) miss.push('almacenamiento privado (OPFS)');
  if (typeof OffscreenCanvas === 'undefined') miss.push('OffscreenCanvas');
  return miss;
}
async function boot() {
  const miss = checkSupport();
  if (miss.length) { panel.show('Navegador no compatible', `Hace falta Google Chrome (o Edge) actualizado. Falta: ${miss.join(', ')}.`); return; }
  if (params.get('snap')) return startGame({ snap: params.get('snap') });
  const cfg = await fetch('/config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  if (cfg.contentBase) return startGame({ source: { kind: 'remote', base: cfg.contentBase } }); // sólo si el sitio tiene autorización para servir los archivos
  const idx = await readIndex();
  if (idx) {
    if (params.has('setup')) return askImport(idx);
    return startGame({ source: { kind: 'pack' } });
  }
  askImport(null);
}
function askImport(idx) {
  panel.show('Importar F1 Challenge CMT 2025', 'Elegí la carpeta de tu instalación ("F1 Challenge 2025 CMT"). Se copia una sola vez al almacenamiento privado de este navegador (unos 3,5 GB); tu instalación no se modifica y nada se sube a ningún servidor.');
  if (window.showDirectoryPicker && !params.has('picker')) panel.button('Elegir carpeta…', async () => { try { const h = await window.showDirectoryPicker({ id: 'f1c-cmt', mode: 'read' }); runImport({ handle: h }); } catch (e) { if (e.name !== 'AbortError') addLog(String(e)); } });
  else { const inp = document.createElement('input'); inp.type = 'file'; inp.webkitdirectory = true; inp.id = 'dirinput'; inp.hidden = true; document.body.append(inp); inp.onchange = () => runImport({ files: [...inp.files] }); panel.button('Elegir carpeta…', () => inp.click()); }
  if (idx) panel.button('Jugar con la copia actual', () => startGame({ source: { kind: 'pack' } }), 'sec');
}
async function runImport(src) {
  panel.show('Importando…', 'Copiando los archivos del juego al almacenamiento privado del navegador. Puede tardar unos minutos.');
  await navigator.storage.persist?.().catch(() => {});
  const est = await navigator.storage.estimate?.().catch(() => null); if (est && est.quota - est.usage < 4.2e9) addLog(`[AVISO] Espacio disponible para el sitio: ${GB(est.quota - est.usage)}`);
  const w = new Worker(new URL('./import-worker.js', import.meta.url), { type: 'module' }); const t0 = performance.now();
  w.onmessage = (ev) => { const m = ev.data;
    if (m.type === 'progress') { const s = (performance.now() - t0) / 1000; panel.progress(Math.min(1, m.bytes / 3.6e9), `${m.files} archivos · ${GB(m.bytes)} · ${(m.bytes / 1048576 / Math.max(s, 0.1)).toFixed(0)} MB/s · ${m.path || ''}`); }
    else if (m.type === 'done') { w.terminate(); addLog(`[IMPORT] ${m.files} archivos, ${GB(m.bytes)} en ${((performance.now() - t0) / 1000).toFixed(0)} s`); startGame({ source: { kind: 'pack' } }); }
    else if (m.type === 'error') { w.terminate(); panel.show('No se pudo importar', m.message); panel.button('Reintentar', () => askImport(null)); } };
  w.postMessage(src);
}
let worker = null, W = 1024, H = 768;
function startGame({ source, snap }) {
  panel.show('Arrancando F1 Challenge CMT 2025', 'El motor original corre emulado (x86 → JavaScript/WebAssembly). La primera vez tarda más: el juego genera sus cachés.');
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); window.f1c.worker = worker;
  const off = canvas.transferControlToOffscreen();
  worker.postMessage({ type: 'start', canvas: off, snap, source, opts: { nodraw: params.has('nodraw') } }, [off]);
  worker.onmessage = onWorker;
}
function onWorker(ev) { const m = ev.data;
  if (m.type === 'status') { if (m.text) $('ptitle').textContent = m.text; }
  else if (m.type === 'progress') panel.progress(m.total ? m.got / m.total : 0, `${m.label}`);
  else if (m.type === 'boot') panel.progress(Math.min(1, m.instr / 1.2e10), `Arranque: ${(m.instr / 1e9).toFixed(1)} mil millones de instrucciones x86 · ${m.files} archivos leídos`);
  else if (m.type === 'ready') { W = m.w; H = m.h; window.f1c.ready = true; }
  else if (m.type === 'firstFrame') { panel.hide(); canvas.focus(); }
  else if (m.type === 'title') document.title = m.text + ' — F1C CMT Web';
  else if (m.type === 'log') { window.f1c.logs.push(m.text); addLog(m.text); }
  else if (m.type === 'stats') { window.f1c.lastStats = m; stats.textContent = `${m.fps.toFixed(1)} fps · ${m.mips.toFixed(0)} MIPS · emu ${m.emuMs.toFixed(1)} ms + gráficos ${m.glMs.toFixed(1)} ms · RAM emulada ${m.heapMB} MB`; }
  else if (m.type === 'halt') { window.f1c.halted = m.report; panel.show('El emulador se detuvo', 'Detalle en el registro de abajo.'); addLog(m.report); panel.button('Volver a cargar', () => location.reload()); }
  else if (m.type === 'shot') window.f1c.shot = m.blob;
  else if (m.type === 'probe') window.f1c.probe = m.data;
}
const pos = (e) => { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(W - 1, Math.round((e.clientX - r.left) / r.width * W))), Math.max(0, Math.min(H - 1, Math.round((e.clientY - r.top) / r.height * H)))]; };
const btn = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);
canvas.addEventListener('mousemove', (e) => { if (!worker) return; const [x, y] = pos(e); worker.postMessage({ type: 'mouse', x, y, button: 0, down: null }); });
canvas.addEventListener('mousedown', (e) => { if (!worker) return; canvas.focus(); const [x, y] = pos(e); worker.postMessage({ type: 'mouse', x, y, button: btn(e.button), down: true }); e.preventDefault(); });
canvas.addEventListener('mouseup', (e) => { if (!worker) return; const [x, y] = pos(e); worker.postMessage({ type: 'mouse', x, y, button: btn(e.button), down: false }); e.preventDefault(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const key = (down) => (e) => { const k = keyFor(e.code); if (!k || !worker) return; e.preventDefault(); if (down && e.repeat) return; worker.postMessage({ type: 'key', k, down }); };
canvas.addEventListener('keydown', key(true)); canvas.addEventListener('keyup', key(false));
$('full').onclick = () => $('wrap').requestFullscreen?.();
window.f1cReset = async () => { await clearPack(); location.reload(); };
boot().catch((e) => { panel.show('Error', String(e.message || e)); addLog(String(e.stack || e)); });
