// binkw32.js — videos Bink: por ahora BinkOpen falla y el juego saltea los videos (el decodificador WASM va después).
import { api } from './common.js';
const A = (n, v) => api(n, typeof v === 'function' ? v : () => v);
export const BINKW32 = {
  '_BinkOpen@8': A(2, (e, p) => { e.log('BINK', `BinkOpen "${e.mem.cstr(p)}" -> sin video (pendiente)`); return 0; }),
  '_BinkGetError@0': A(0, (e) => (e.binkErr ??= (() => { const p = e.mem.alloc(32); e.mem.writeCStr(p, 'Bink no disponible', 32); return p; })())),
  '_BinkClose@4': A(1, 0), '_BinkSetVolume@12': A(3, 0), '_BinkWait@4': A(1, 0), '_BinkDoFrame@4': A(1, 0), '_BinkNextFrame@4': A(1, 0),
  '_BinkCopyToBuffer@28': A(7, 0), '_BinkGetSummary@8': A(2, 0), '_BinkOpenMiles@4': A(1, 0), '_BinkSetSoundSystem@8': A(2, 1), '_BinkOpenDirectSound@4': A(1, 0), '_BinkSetSoundTrack@8': A(2, 0),
};
