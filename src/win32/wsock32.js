// wsock32.js — WinSock 1.1 por ordinal. Fase actual: pila "sin red" (sockets locales que no reciben nada).
// La red real (salas en Cloudflare) reemplaza send/recv en la fase online.
import { api } from './common.js';
const WSAEWOULDBLOCK = 10035, SOCKET_ERROR = 0xffffffff;
const sw16 = (v) => ((v & 0xff) << 8) | ((v >> 8) & 0xff);
const sw32 = (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
const N = (e) => (e.net ??= { seq: 0x200, socks: new Map(), err: 0 });
export const WSOCK32 = {
  '#115': api(2, (e, ver, p) => { e.mem.fill(p, 0, 400); e.mem.w16(p, 0x0101); e.mem.w16(p + 2, 0x0101); e.mem.writeCStr(p + 4, 'F1C Web WinSock', 257); e.log('NET', 'WSAStartup'); return 0; }),
  '#116': api(0, () => 0), '#111': api(0, (e) => N(e).err),
  '#23': api(3, (e, af, type, proto) => { const n = N(e); const s = n.seq++; n.socks.set(s, { type }); e.log('NET', `socket(${af}, ${type === 1 ? 'TCP' : 'UDP'}) -> ${s}`); return s; }),
  '#3': api(1, (e, s) => { N(e).socks.delete(s); return 0; }),
  '#2': api(3, (e, s, p) => { const port = sw16(e.mem.r16(p + 2)); const so = N(e).socks.get(s); if (so) so.port = port; e.log('NET', `bind(${s}, puerto ${port})`); return 0; }),
  '#13': api(2, () => 0), '#1': api(3, (e) => { N(e).err = WSAEWOULDBLOCK; return SOCKET_ERROR; }), '#4': api(3, (e) => { N(e).err = WSAEWOULDBLOCK; return SOCKET_ERROR; }),
  '#5': api(3, () => SOCKET_ERROR), '#6': api(3, (e, s, p, pl) => { e.mem.fill(p, 0, 16); e.mem.w16(p, 2); e.mem.w16(p + 2, sw16(N(e).socks.get(s)?.port || 0)); return 0; }),
  '#8': api(1, (e, v) => sw32(v)), '#9': api(1, (e, v) => sw16(v)), '#15': api(1, (e, v) => sw16(v)),
  '#10': api(1, (e, p) => { const s = e.mem.cstr(p); const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); return m ? ((+m[1]) | (+m[2] << 8) | (+m[3] << 16) | (+m[4] << 24)) >>> 0 : 0xffffffff; }),
  '#11': api(1, (e, a) => { const p = (e.net.ntoa ??= e.mem.alloc(16)); e.mem.writeCStr(p, `${a & 255}.${(a >> 8) & 255}.${(a >> 16) & 255}.${a >>> 24}`, 16); return p; }),
  '#16': api(4, (e) => { N(e).err = WSAEWOULDBLOCK; return SOCKET_ERROR; }), '#17': api(6, (e) => { N(e).err = WSAEWOULDBLOCK; return SOCKET_ERROR; }),
  '#19': api(4, (e, s, b, n) => n), '#20': api(6, (e, s, b, n) => n),
  '#18': api(5, (e, nfds, r, w, x, t) => { for (const p of [r, x]) if (p) e.mem.w32(p, 0); return w ? e.mem.r32(w) : 0; }),
  '#21': api(5, () => 0), '#22': api(2, () => 0), '#151': api(2, (e, s, set) => { const n = e.mem.r32(set); for (let i = 0; i < n; i++) if (e.mem.r32(set + 4 + 4 * i) === s) return 1; return 0; }),
  '#52': api(1, (e, p) => { e.log('NET', `gethostbyname("${e.mem.cstr(p)}") -> sin red`); N(e).err = 11001; return 0; }),
  '#101': api(4, () => 0),
};
