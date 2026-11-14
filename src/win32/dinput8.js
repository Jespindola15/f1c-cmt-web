// dinput8.js — DirectInput 8 (ANSI). Teclado: estado de 256 bytes desde emu.keys (scancodes DIK).
// Joystick/volante: se enumeran los que el host expone en emu.joysticks (Gamepad API en Chrome).
import { api, HaltSignal } from './common.js';
const DI_OK = 0, DIERR_UNSUPPORTED = 0x80004001, DIERR_NOTFOUND = 0x80070002;
const GUID_SysKeyboard = '6f1d2b61d5a011cfbfc7444553540000', GUID_SysMouse = '6f1d2b60d5a011cfbfc7444553540000';
const guidHex = (e, p) => { let s = ''; for (let i = 0; i < 16; i++) s += e.mem.r8(p + i).toString(16).padStart(2, '0'); return s; };
function wrap(iface, n, fn) { return (e2, self, ...a) => { if (!fn) throw new HaltSignal(`DirectInput no implementado: ${iface}::${n}`); const r = fn(e2, e2.di.objs.get(self), self, ...a); return r === undefined ? DI_OK : r; }; }
export function comTable() { const t = new Map(); for (const [iface, ms] of [['IDirectInput8A', di8Methods()], ['IDirectInputDevice8A', devMethods()]]) ms.forEach(([n, k, fn]) => t.set(`${iface}::${n}`, { n: k + 1, fn: wrap(iface, n, fn) })); return t; }
function com(e, iface, methods, st) {
  e.state.diVt ??= new Map(); let vt = e.state.diVt.get(iface);
  if (!vt) { vt = e.mem.alloc(4 * methods.length);
    methods.forEach(([n, k, fn], i) => e.mem.w32(vt + 4 * i, e.hostFunction(`${iface}::${n}`, k + 1, wrap(iface, n, fn))));
    e.state.diVt.set(iface, vt); }
  const o = e.mem.alloc(16); e.mem.w32(o, vt); st.addr = o; st.refs = 1; e.di.objs.set(o, st); return o;
}
const U = () => [['QueryInterface', 2, (e, o, s, r, pp) => { e.mem.w32(pp, s); o.refs++; }], ['AddRef', 0, (e, o) => ++o.refs], ['Release', 0, (e, o) => Math.max(0, --o.refs)]];
function devMethods() {
  return [...U(),
    ['GetCapabilities', 1, (e2, o, s, p) => { const sz = e2.mem.r32(p) || 44; e2.mem.fill(p + 4, 0, sz - 4); e2.mem.w32(p + 4, 5); const kind = o.kind; e2.mem.w32(p + 8, kind === 'keyboard' ? 0x13 : kind === 'mouse' ? 0x12 : 0x14); e2.mem.w32(p + 12, kind === 'joystick' ? 6 : kind === 'mouse' ? 3 : 0); e2.mem.w32(p + 16, kind === 'joystick' ? 32 : kind === 'keyboard' ? 128 : 4); }],
    ['EnumObjects', 3, () => DI_OK], ['GetProperty', 2, () => DIERR_UNSUPPORTED], ['SetProperty', 2, () => DI_OK],
    ['Acquire', 0, (e2, o) => { o.acquired = true; }], ['Unacquire', 0, (e2, o) => { o.acquired = false; }],
    ['GetDeviceState', 2, (e2, o, s, size, p) => { e2.mem.fill(p, 0, size);
      if (o.kind === 'keyboard' && e2.keys) for (let i = 0; i < Math.min(256, size); i++) if (e2.keys[i]) e2.mem.w8(p + i, 0x80);
      if (o.kind === 'joystick' && e2.joyState) e2.joyState(o, p, size); }],
    ['GetDeviceData', 4, (e2, o, s, cb, p, pn) => { e2.mem.w32(pn, 0); }],
    ['SetDataFormat', 1, (e2, o, s, p) => { o.fmtSize = e2.mem.r32(p + 12); }], ['SetEventNotification', 1, () => DI_OK], ['SetCooperativeLevel', 2, () => DI_OK],
    ['GetObjectInfo', 3, () => DIERR_NOTFOUND], ['GetDeviceInfo', 1, (e2, o, s, p) => { const sz = e2.mem.r32(p); e2.mem.fill(p + 4, 0, sz - 4); e2.mem.writeCStr(p + 52, o.kind, 260); }],
    ['RunControlPanel', 2, () => DI_OK], ['Initialize', 3, () => DI_OK], ['CreateEffect', 4, () => DIERR_UNSUPPORTED], ['EnumEffects', 3, () => DI_OK],
    ['GetEffectInfo', 2, () => DIERR_UNSUPPORTED], ['GetForceFeedbackState', 1, () => DIERR_UNSUPPORTED], ['SendForceFeedbackCommand', 1, () => DIERR_UNSUPPORTED],
    ['EnumCreatedEffectObjects', 3, () => DI_OK], ['Escape', 1, () => DIERR_UNSUPPORTED], ['Poll', 0, () => 1], ['SendDeviceData', 4, () => DI_OK],
    ['EnumEffectsInFile', 4, () => DI_OK], ['WriteEffectToFile', 4, () => DIERR_UNSUPPORTED], ['BuildActionMap', 3, () => DIERR_UNSUPPORTED], ['SetActionMap', 3, () => DIERR_UNSUPPORTED], ['GetImageInfo', 1, () => DIERR_UNSUPPORTED],
  ];
}
function device(e, guid) {
  const kind = guid === GUID_SysKeyboard ? 'keyboard' : guid === GUID_SysMouse ? 'mouse' : 'joystick';
  const st = { kind, guid, acquired: false, fmtSize: 0 };
  return com(e, 'IDirectInputDevice8A', devMethods(), st);
}
function di8Methods() {
  return [...U(),
      ['CreateDevice', 3, (e2, o, s, rguid, ppd) => { const g = guidHex(e2, rguid); e2.log('DINPUT', `CreateDevice ${g === GUID_SysKeyboard ? 'teclado' : g === GUID_SysMouse ? 'mouse' : g}`); e2.mem.w32(ppd, device(e2, g)); }],
      ['EnumDevices', 4, (e2, o, s, type, cb, ref, flags) => { e2.log('DINPUT', `EnumDevices tipo=${type} (sin joysticks por ahora)`); }],
      ['GetDeviceStatus', 1, () => DI_OK], ['RunControlPanel', 2, () => DI_OK], ['Initialize', 2, () => DI_OK], ['FindDevice', 3, () => DIERR_NOTFOUND],
      ['EnumDevicesBySemantics', 5, () => DI_OK], ['ConfigureDevices', 4, () => DIERR_UNSUPPORTED],
    ];
}
export const DINPUT8 = {
  DirectInput8Create: api(5, (e, hinst, ver, riid, pp, unk) => {
    e.di = { objs: new Map() }; e.log('DINPUT', `DirectInput8Create ver=0x${ver.toString(16)}`);
    e.mem.w32(pp, com(e, 'IDirectInput8A', di8Methods(), {}));
    return DI_OK;
  }),
};
