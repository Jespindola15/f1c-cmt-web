// f1c.js — extensión EXPERIMENTAL para probar F1C CMT 2025 sobre el núcleo de Daytona Web.
// VFS respaldado por disco (solo lectura; las escrituras quedan en memoria), directorios y cwd reales,
// y las APIs que F1C importa y Daytona no implementa. Direct3DCreate8 → objeto IDirect3D8 mínimo.
import { api, stub, HaltSignal } from './common.js';

const fill = (emu, p, it) => { const m = emu.mem; m.fill(p, 0, 320); m.w32(p, it.isDir ? 0x10 : 0x80); m.w32(p + 32, it.size); m.writeCStr(p + 44, it.name, 260); };
const ok1 = (n) => api(n, () => 1);
export const KERNEL32 = {
  // Reloj virtual (pruebas en Node): cada lectura del contador avanza qpcTurboMs, así las esperas activas terminan.
  QueryPerformanceCounter: api(1, (emu, p) => { if (emu.clockMode === 'virtual' && emu.qpcTurboMs) emu.timeOffset += emu.qpcTurboMs;
    const us = Math.floor(emu.nowMs() * 1000); emu.mem.w32(p, us >>> 0); emu.mem.w32(p + 4, Math.floor(us / 4294967296)); return 1; }, { quiet: true }),
  SetCurrentDirectoryA: api(1, (emu, p) => { const s = emu.mem.cstr(p); emu.note(`"${s}"`); const n = emu.vfs.norm(s); if (!emu.vfs.dirs.has(n)) return 0; emu.vfs.cwd = n; return 1; }),
  GetCurrentDirectoryA: api(2, (emu, n, buf) => emu.mem.writeCStr(buf, 'C:\\F1C' + (emu.vfs.cwd ? '\\' + emu.vfs.cwd : ''), n)),
  GetFullPathNameA: api(4, (emu, p, n, buf, pFile) => { const s = 'C:\\F1C\\' + emu.vfs.norm(emu.mem.cstr(p)); const k = emu.mem.writeCStr(buf, s, n); if (pFile) emu.mem.w32(pFile, buf + s.lastIndexOf('\\') + 1); return k; }),
  GetFileAttributesA: api(1, (emu, p) => { const s = emu.mem.cstr(p); if (emu.vfs.isDir(s)) return 0x10; return emu.vfs.find(s) ? 0x80 : 0xffffffff; }),
  FindFirstFileA: api(2, (emu, p, out) => { const pat = emu.mem.cstr(p); const list = emu.vfs.list(pat); emu.note(`"${pat}" -> ${list.length}`);
    if (!list.length) { emu.lastError = 2; return 0xffffffff; } const h = emu.newHandle({ type: 'find', list, i: 0 }); fill(emu, out, list[0]); return h; }),
  FindNextFileA: api(2, (emu, h, out) => { const o = emu.handles.get(h); if (!o || ++o.i >= o.list.length) { emu.lastError = 18; return 0; } fill(emu, out, o.list[o.i]); return 1; }),
  GetFileInformationByHandle: api(2, (emu, h, p) => { const o = emu.handles.get(h); emu.mem.fill(p, 0, 52); emu.mem.w32(p, 0x80); emu.mem.w32(p + 36, o?.file ? o.file.data.length : 0); return 1; }),
  IsProcessorFeaturePresent: api(1, (emu, f) => ((emu.cpuFeatures ?? [2, 3, 6, 8, 10, 12]).includes(f) ? 1 : 0)), // MMX, SSE, SSE2 sí; 3DNow! (7) y SSE3 (13) no
  CompareStringW: api(6, () => 2), GetLocaleInfoW: api(4, () => 0), SetEnvironmentVariableA: ok1(2),
  PeekNamedPipe: api(6, () => 0), CreateProcessA: api(10, (emu, app, cmd) => { emu.log('F1C', `CreateProcessA("${app ? emu.mem.cstr(app) : ''}", "${cmd ? emu.mem.cstr(cmd) : ''}") -> rechazado`); return 0; }), DuplicateHandle: ok1(7),
  RaiseException: api(4, (emu, c) => { throw new HaltSignal(`RaiseException 0x${(c >>> 0).toString(16)}`); }),
  GetUserDefaultLCID: api(0, () => 0x409), EnumSystemLocalesA: ok1(2), IsValidCodePage: ok1(1), IsValidLocale: ok1(2),
  SetFileAttributesA: ok1(2), CopyFileA: ok1(3), MoveFileA: ok1(2), CreateDirectoryA: ok1(2), RemoveDirectoryA: ok1(1),
  QueueUserAPC: ok1(3), ResumeThread: ok1(1), SuspendThread: api(1, () => 0), SetThreadPriority: ok1(2), SleepEx: api(2, () => 0),
  CreateThread: api(6, (emu, sa, ss, start, param, fl, tid) => { emu.log('F1C', `CreateThread start=0x${start.toString(16)} (no ejecutado)`); if (tid) emu.mem.w32(tid, 0x777); return 0x7770; }),
  CompareFileTime: api(2, () => 0), GetPriorityClass: api(1, () => 0x20),
};
export const USER32 = { DestroyCursor: ok1(1), ToAsciiEx: api(6, () => 0), MapVirtualKeyExA: api(3, () => 0), GetKeyboardLayout: api(1, () => 0x04090409) };
const adv = {}; for (const [n, k] of [['SetSecurityDescriptorOwner',3],['RevertToSelf',0],['IsValidSecurityDescriptor',1],['ImpersonateSelf',1],['OpenThreadToken',4],['OpenProcessToken',3],['AllocateAndInitializeSid',11],['InitializeSecurityDescriptor',2],['InitializeAcl',3],['AddAccessAllowedAce',4],['SetSecurityDescriptorDacl',4],['SetSecurityDescriptorGroup',3]]) adv[n] = ok1(k);
adv.FreeSid = api(1, () => 0); adv.GetLengthSid = api(1, () => 12);
adv.AccessCheck = api(8, (emu, sd, tok, acc, gm, ps, psl, gr, st) => { emu.mem.w32(gr, acc); emu.mem.w32(st, 1); return 1; });
export const ADVAPI32 = adv;
export const SHELL32 = { SHGetSpecialFolderPathA: api(4, (emu, h, buf) => { emu.mem.writeCStr(buf, 'C:\\F1C\\Users', 260); return 1; }) };
export const AVIFIL32 = { AVIFileExit: api(0, () => 0), AVIFileRelease: api(1, () => 0), AVIStreamRelease: api(1, () => 0) };
// IDirect3D8 mínimo: lo justo para llegar a CreateDevice y medir.
const MODES = []; for (const f of [23, 22]) for (const [w, h] of [[640,480],[800,600],[1024,768],[1280,720],[1280,1024],[1600,900],[1920,1080]]) for (const hz of [60, 75]) MODES.push([w, h, hz, f]);
export const D3D8 = {
  Direct3DCreate8: api(1, (emu, sdk) => {
    emu.log('F1C', `Direct3DCreate8(${sdk}) en instr=${emu.cpu.icount}`); emu.f1cMark = { d3dcreate: emu.cpu.icount, t: Date.now() };
    const m = (label, n, fn) => emu.hostFunction('IDirect3D8::' + label, n, fn);
    const meths = [
      m('QueryInterface', 3, () => 0x80004002), m('AddRef', 1, () => 1), m('Release', 1, () => 0), m('RegisterSoftwareDevice', 2, () => 0),
      m('GetAdapterCount', 1, () => 1),
      m('GetAdapterIdentifier', 4, (e, t, a, f, p) => { e.mem.fill(p, 0, 1064); e.mem.writeCStr(p, 'webgl2.dll', 512); e.mem.writeCStr(p + 512, 'WebGL2', 512); e.mem.w32(p + 1032, 0x10de); [0xe2,0x1e,0xb7,0xd7,0x9f,0x24,0xcf,0x11,0xec,0x70,0xc9,0x52,0x5c,0xc2,0xd6,0x35].forEach((b, k) => e.mem.w8(p + 1048 + k, b)); return 0; }), // GUID = VIDEOGUID de Config.ini
      m('GetAdapterModeCount', 2, () => MODES.length),
      m('EnumAdapterModes', 4, (e, t, a, i, p) => { const v = MODES[i]; if (!v) return 0x8876086c; v.forEach((x, k) => e.mem.w32(p + 4 * k, x)); return 0; }),
      m('GetAdapterDisplayMode', 3, (e, t, a, p) => { [1920, 1080, 60, 22].forEach((x, k) => e.mem.w32(p + 4 * k, x)); return 0; }),
      m('CheckDeviceType', 6, () => 0), m('CheckDeviceFormat', 7, () => 0),
      m('CheckDeviceMultiSampleType', 6, (e, t, a, d, f, w, ms) => (ms === 0 || ms === 2 || ms === 4 ? 0 : 0x8876086a)),
      m('CheckDepthStencilMatch', 6, () => 0),
      m('GetDeviceCaps', 4, (e, t, a, d, p) => { e.mem.fill(p, 0, 212); const W = (o, v) => e.mem.w32(p + o, v);
        W(0, 1); W(28, 0x1bfef0); W(88, 4096); W(92, 4096); W(144, 0x3ffffff); W(148, 8); W(152, 4); W(160, 8); W(188, 16); W(196, 0xfffe0101); W(204, 0xffff0104); return 0; }),
      m('GetMonitor', 2, () => 0x12340000),
      m('CreateDevice', 7, (e, t, a, dt, hw, flags) => { const ms = Date.now() - e.f1cT0; e.log('F1C', `CreateDevice flags=0x${flags.toString(16)} en instr=${e.cpu.icount} tiempo=${ms} ms`); throw new HaltSignal(`F1C: CreateDevice alcanzado (instr=${e.cpu.icount}, ${ms} ms, ${(e.cpu.icount / ms / 1000).toFixed(1)} MIPS)`); }),
    ];
    const vt = emu.mem.alloc ? emu.mem.alloc(4 * meths.length) : null;
    const obj = emu.mem.alloc(8); const vtab = vt; meths.forEach((a, i) => emu.mem.w32(vtab + 4 * i, a)); emu.mem.w32(obj, vtab);
    return obj;
  }),
};
const mssNames = ['_AIL_startup@0','_AIL_shutdown@0','_AIL_set_preference@8','_AIL_open_digital_driver@16','_AIL_set_DirectSound_HWND@8','_AIL_serve@0'];
export const MSS32 = Object.fromEntries(mssNames.map((n) => [n, api(+n.split('@')[1] / 4, () => 0)]));
