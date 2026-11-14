// pack.js — copia local de la instalación del jugador en OPFS (Origin Private File System, persistente).
// La instalación original no se modifica: se lee una vez (selector de carpeta) y se empaqueta en archivos grandes
// (f1c/pack-NNN.bin + f1c/index.json). Desde el worker del emulador se leen con FileSystemSyncAccessHandle
// (lectura síncrona, que es lo que necesita el código x86 emulado al llamar a ReadFile).
// Lo que el juego escribe (partidas, .HAT, registros) va a f1c/user/ (un archivo OPFS por ruta).
import { SKIP_RE } from '../src/vfs-core.js';
const PACK_MAX = 1 << 30; // 1 GiB por paquete
export async function opfsRoot() { return (await navigator.storage.getDirectory()).getDirectoryHandle('f1c', { create: true }); }
export async function readIndex() {
  try { const d = await opfsRoot(); const f = await (await d.getFileHandle('index.json')).getFile(); return JSON.parse(await f.text()); } catch { return null; }
}
export async function clearPack() { const root = await navigator.storage.getDirectory(); await root.removeEntry('f1c', { recursive: true }).catch(() => {}); }

// Recorre la carpeta elegida (FileSystemDirectoryHandle) o una lista de File (input webkitdirectory).
export async function* walkHandle(dir, rel = '') {
  for await (const [name, h] of dir.entries()) {
    const r = rel ? rel + '\\' + name : name; if (SKIP_RE.test(r)) continue;
    if (h.kind === 'directory') { yield { dir: r }; yield* walkHandle(h, r); } else yield { path: r, get: () => h.getFile() };
  }
}
export function* walkFiles(fileList) {
  const dirs = new Set();
  for (const f of fileList) { const parts = f.webkitRelativePath.split('/').slice(1); const r = parts.join('\\'); if (!r || SKIP_RE.test(r)) continue;
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('\\'); if (!dirs.has(d)) { dirs.add(d); yield { dir: d }; } }
    yield { path: r, get: async () => f }; }
}
// Importación (en un worker: usa escrituras síncronas). onProgress({files, bytes, path})
export async function importInto(items, onProgress) {
  const root = await opfsRoot();
  await root.removeEntry('index.json').catch(() => {});
  // reanudación: si una importación anterior quedó a medias, se conservan los archivos ya copiados
  let prev = null; try { prev = JSON.parse(await (await (await root.getFileHandle('index.partial.json')).getFile()).text()); } catch {}
  const have = new Map(); if (prev) for (const f of prev.files) have.set(f[0], f);
  const files = [], dirs = []; let pack = prev ? prev.pack - 1 : -1, h = null, off = 0, bytes = 0, n = 0, lastSave = 0;
  const open = async (keep) => { if (h) { h.flush(); h.close(); } pack++; const fh = await root.getFileHandle(`pack-${String(pack).padStart(3, '0')}.bin`, { create: true }); h = await fh.createSyncAccessHandle(); if (keep) off = h.getSize(); else { h.truncate(0); off = 0; } };
  await open(!!prev);
  if (prev) off = Math.max(off, prev.off);
  const checkpoint = async () => { const w = await (await root.getFileHandle('index.partial.json', { create: true })).createWritable(); await w.write(JSON.stringify({ files: files.concat([...have.values()].filter((f) => !files.some((g) => g[0] === f[0]))), pack, off })); await w.close(); };
  for await (const it of items) {
    if (it.dir) { dirs.push(it.dir); continue; }
    const old = have.get(it.path);
    const file = await it.get();
    if (old && old[1] === file.size) { files.push(old); have.delete(it.path); bytes += old[1]; n++; continue; }
    const buf = new Uint8Array(await file.arrayBuffer());
    if (off + buf.length > PACK_MAX && off > 0) await open(false);
    let w = 0; while (w < buf.length) w += h.write(buf.subarray(w), { at: off + w });
    files.push([it.path, buf.length, pack, off]); off += buf.length; bytes += buf.length; n++;
    if (n % 20 === 0) onProgress?.({ files: n, bytes, path: it.path });
    if (n - lastSave >= 300) { lastSave = n; h.flush(); await checkpoint(); }
  }
  h.flush(); h.close();
  const exe = files.find((f) => f[0].toUpperCase() === 'F1C_CMT.EXE');
  if (!exe) throw new Error('La carpeta elegida no contiene F1C_CMT.exe (elegí la carpeta "F1 Challenge 2025 CMT").');
  const idx = { version: 1, created: new Date().toISOString(), packs: pack + 1, bytes, files, dirs };
  const ih = await (await root.getFileHandle('index.json', { create: true })).createWritable(); await ih.write(JSON.stringify(idx)); await ih.close();
  await root.removeEntry('index.partial.json').catch(() => {});
  onProgress?.({ files: n, bytes, done: true });
  return idx;
}
// Lectura síncrona desde el worker del emulador
export async function openPacks(idx) {
  const root = await opfsRoot(); const hs = [];
  for (let i = 0; i < idx.packs; i++) hs.push(await (await root.getFileHandle(`pack-${String(i).padStart(3, '0')}.bin`)).createSyncAccessHandle());
  return { read(e) { const b = new Uint8Array(e.size); let r = 0; while (r < e.size) { const k = hs[e.pack].read(b.subarray(r), { at: e.offset + r }); if (k <= 0) break; r += k; } return b; }, close() { for (const h of hs) h.close(); } };
}
// Capa de escritura del juego (persistente)
const enc = (k) => encodeURIComponent(k).replace(/\./g, '%2E');
export async function userDir() { return (await opfsRoot()).getDirectoryHandle('user', { create: true }); }
export async function loadUserFiles() {
  const d = await userDir(); const out = [];
  for await (const [name, h] of d.entries()) if (h.kind === 'file') out.push([decodeURIComponent(name), new Uint8Array(await (await h.getFile()).arrayBuffer())]);
  return out;
}
let chain = Promise.resolve();
export function saveUserFile(k, data) { const copy = data.slice(); chain = chain.then(async () => { const d = await userDir(); const w = await (await d.getFileHandle(enc(k), { create: true })).createWritable(); await w.write(copy); await w.close(); }).catch((e) => console.warn('OPFS', k, e)); return chain; }
export function deleteUserFile(k) { chain = chain.then(async () => (await userDir()).removeEntry(enc(k)).catch(() => {})); return chain; }
