// Worker de importación: copia la carpeta del juego elegida por el jugador al almacenamiento privado del navegador.
import { importInto, walkHandle, walkFiles } from './pack.js';
self.onmessage = async (ev) => {
  const { handle, files } = ev.data;
  try { const idx = await importInto(handle ? walkHandle(handle) : walkFiles(files), (p) => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', files: idx.files.length, bytes: idx.bytes }); }
  catch (e) { self.postMessage({ type: 'error', message: String(e.message || e) }); }
};
