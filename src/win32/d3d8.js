// d3d8.js — Direct3D 8 para F1C: IDirect3D8 + IDirect3DDevice8 completos (97 métodos), texturas, superficies,
// vertex/index buffers en memoria emulada (el juego hace Lock y escribe ahí). El dibujo real lo hace el "backend"
// (emu.d3dBackend): en Node se registra; en Chrome se traduce a WebGL2. Todo método no implementado se detiene.
import { api, HaltSignal } from './common.js';

const D3D_OK = 0, D3DERR_NOTAVAILABLE = 0x8876086a, D3DERR_INVALIDCALL = 0x8876086c, E_NOINTERFACE = 0x80004002;
export const FMT = { 20: 'R8G8B8', 21: 'A8R8G8B8', 22: 'X8R8G8B8', 23: 'R5G6B5', 24: 'X1R5G5B5', 25: 'A1R5G5B5', 26: 'A4R4G4B4', 28: 'A8', 41: 'P8', 50: 'L8', 51: 'A8L8',
  71: 'D32', 75: 'D24S8', 77: 'D24X8', 80: 'D16', 101: 'INDEX16', 102: 'INDEX32', 0x31545844: 'DXT1', 0x32545844: 'DXT2', 0x33545844: 'DXT3', 0x34545844: 'DXT4', 0x35545844: 'DXT5' };
const BPP = { 20: 3, 21: 4, 22: 4, 23: 2, 24: 2, 25: 2, 26: 2, 28: 1, 41: 1, 50: 1, 51: 2, 71: 4, 75: 4, 77: 4, 80: 2 };
const isDXT = (f) => f >= 0x31545844 && f <= 0x35545844;
export function surfSize(fmt, w, h) {
  if (isDXT(fmt)) { const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2); const bs = fmt === 0x31545844 ? 8 : 16; return { pitch: bw * bs, size: bw * bs * bh }; }
  const b = BPP[fmt]; if (!b) return null; return { pitch: w * b, size: w * b * h };
}
const MODES = []; for (const f of [22, 23]) for (const [w, h] of [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 1024], [1600, 900], [1920, 1080]]) for (const hz of [60, 75]) MODES.push([w, h, hz, f]);
export const ADAPTER_GUID = [0xe2, 0x1e, 0xb7, 0xd7, 0x9f, 0x24, 0xcf, 0x11, 0xec, 0x70, 0xc9, 0x52, 0x5c, 0xc2, 0xd6, 0x35];

// ---------- utilidades COM ----------
function makeCom(emu, iface, methods, state) {
  const st = emu.state; st.d3dVt ??= new Map();
  let vt = st.d3dVt.get(iface);
  if (!vt) {
    vt = emu.mem.alloc(4 * methods.length);
    methods.forEach(([name, n, fn], i) => {
      const label = `${iface}::${name}`;
      const impl = fn || ((e) => { throw new HaltSignal(`Método D3D no implementado: ${label}`); });
      emu.mem.w32(vt + 4 * i, emu.hostFunction(label, n + 1, (e, self, ...a) => { const r = impl(e, e.d3d.objs.get(self) ?? null, self, ...a); return r === undefined ? D3D_OK : r; }));
    });
    st.d3dVt.set(iface, vt);
  }
  const obj = emu.mem.alloc(16); emu.mem.w32(obj, vt);
  state.addr = obj; state.refs = 1; state.iface = iface; emu.d3d.objs.set(obj, state);
  return obj;
}
const unk = (extra = {}) => [
  ['QueryInterface', 2, (e, o, self, riid, pp) => { e.mem.w32(pp, self); o.refs++; return D3D_OK; }],
  ['AddRef', 0, (e, o) => ++o.refs],
  ['Release', 0, (e, o, self) => { o.refs--; if (o.refs <= 0) { e.d3d.release?.(o); } return Math.max(0, o.refs); }],
];
const resource = () => [
  ['GetDevice', 1, (e, o, self, pp) => { e.mem.w32(pp, e.d3d.device.addr); e.d3d.device.refs++; }],
  ['SetPrivateData', 4, () => D3D_OK], ['GetPrivateData', 3, () => D3DERR_NOTAVAILABLE], ['FreePrivateData', 1, () => D3D_OK],
  ['SetPriority', 1, () => 0], ['GetPriority', 0, () => 0], ['PreLoad', 0, () => 0], ['GetType', 0, (e, o) => o.rtype],
];
function writeSurfDesc(e, p, s) { [s.fmt, s.rtype ?? 1, s.usage ?? 0, s.pool ?? 0, s.size, 0, s.w, s.h].forEach((v, i) => e.mem.w32(p + 4 * i, v)); }

// ---------- superficies y texturas ----------
function newSurface(e, w, h, fmt, usage, pool, kind, container) {
  const sz = surfSize(fmt, w, h);
  if (!sz) throw new HaltSignal(`Formato de superficie no soportado: ${FMT[fmt] || '0x' + fmt.toString(16)} (${w}x${h})`);
  const mem = (kind === 'depth' || kind === 'backbuffer') ? 0 : e.mem.alloc(sz.size);
  const s = { kind, w, h, fmt, usage, pool, size: sz.size, pitch: sz.pitch, mem, rtype: 1, container, dirty: true, locks: 0 };
  const addr = makeCom(e, 'IDirect3DSurface8', [...unk(), ['GetDevice', 1, (e2, o, self, pp) => { e2.mem.w32(pp, e2.d3d.device.addr); }],
    ['SetPrivateData', 4, () => D3D_OK], ['GetPrivateData', 3, () => D3DERR_NOTAVAILABLE], ['FreePrivateData', 1, () => D3D_OK],
    ['GetContainer', 2, (e2, o, self, riid, pp) => { if (!o.container) return E_NOINTERFACE; e2.mem.w32(pp, o.container.addr); o.container.refs++; }],
    ['GetDesc', 1, (e2, o, self, p) => writeSurfDesc(e2, p, o)],
    ['LockRect', 3, (e2, o, self, pLocked, pRect, flags) => {
      if (!o.mem) { o.mem = e2.mem.alloc(o.size); } // backbuffer/depth: memoria a demanda
      let off = 0; if (pRect) { const x = e2.mem.r32(pRect), y = e2.mem.r32(pRect + 4); off = isDXT(o.fmt) ? (y >> 2) * o.pitch + (x >> 2) * (o.fmt === 0x31545844 ? 8 : 16) : y * o.pitch + x * BPP[o.fmt]; }
      e2.mem.w32(pLocked, o.pitch); e2.mem.w32(pLocked + 4, o.mem + off); o.locks++; e2.d3d.stats.locks++; }],
    ['UnlockRect', 0, (e2, o) => { o.dirty = true; if (o.container) o.container.dirty = true; e2.d3dBackend?.surfaceChanged?.(o); }],
  ], s);
  return [addr, s];
}
function newTexture(e, w, h, levels, usage, fmt, pool) {
  if (!levels) { levels = 1; let a = w, b = h; while (a > 1 || b > 1) { a = Math.max(1, a >> 1); b = Math.max(1, b >> 1); levels++; } }
  const t = { kind: 'texture', w, h, levels, usage, fmt, pool, rtype: 3, surfaces: [], dirty: true, id: ++e.d3d.texSeq };
  const addr = makeCom(e, 'IDirect3DTexture8', [...unk(), ...resource(),
    ['SetLOD', 1, () => 0], ['GetLOD', 0, () => 0], ['GetLevelCount', 0, (e2, o) => o.levels],
    ['GetLevelDesc', 2, (e2, o, self, lvl, p) => { const s = o.surfaces[lvl]; if (!s) return D3DERR_INVALIDCALL; writeSurfDesc(e2, p, s); }],
    ['GetSurfaceLevel', 2, (e2, o, self, lvl, pp) => { const s = o.surfaces[lvl]; if (!s) return D3DERR_INVALIDCALL; s.refs++; e2.mem.w32(pp, s.addr); }],
    ['LockRect', 4, (e2, o, self, lvl, pLocked, pRect, flags) => { const s = o.surfaces[lvl]; if (!s) return D3DERR_INVALIDCALL; e2.mem.w32(pLocked, s.pitch); e2.mem.w32(pLocked + 4, s.mem); s.locks++; e2.d3d.stats.locks++; }],
    ['UnlockRect', 1, (e2, o, self, lvl) => { const s = o.surfaces[lvl]; if (s) s.dirty = true; o.dirty = true; e2.d3dBackend?.textureChanged?.(o, lvl); }],
    ['AddDirtyRect', 1, (e2, o) => { o.dirty = true; }],
  ], t);
  let a = w, b = h;
  for (let i = 0; i < levels; i++) { const [, s] = newSurface(e, a, b, fmt, usage, pool, 'level', t); s.level = i; t.surfaces.push(s); a = Math.max(1, a >> 1); b = Math.max(1, b >> 1); }
  e.d3d.stats.textures++; e.d3d.stats.texBytes += t.surfaces.reduce((x, s) => x + s.size, 0);
  e.d3d.formats[FMT[fmt] || fmt] = (e.d3d.formats[FMT[fmt] || fmt] || 0) + 1;
  return addr;
}
function newBuffer(e, kind, len, usage, fmtOrFvf, pool) {
  const b = { kind, len, usage, fvf: kind === 'vb' ? fmtOrFvf : 0, fmt: kind === 'ib' ? fmtOrFvf : 0, pool, mem: e.mem.alloc(Math.max(len, 16)), rtype: kind === 'vb' ? 6 : 7, dirty: true, id: ++e.d3d.bufSeq };
  return makeCom(e, kind === 'vb' ? 'IDirect3DVertexBuffer8' : 'IDirect3DIndexBuffer8', [...unk(), ...resource(),
    ['Lock', 4, (e2, o, self, off, size, pp, flags) => { e2.mem.w32(pp, o.mem + off); e2.d3d.stats.bufLocks++; }],
    ['Unlock', 0, (e2, o) => { o.dirty = true; e2.d3dBackend?.bufferChanged?.(o); }],
    ['GetDesc', 1, (e2, o, self, p) => { const v = o.kind === 'vb' ? [0, 6, o.usage, o.pool, o.len, o.fvf] : [o.fmt, 7, o.usage, o.pool, o.len]; v.forEach((x, i) => e2.mem.w32(p + 4 * i, x)); }],
  ], b);
}

// ---------- dispositivo ----------
function createDevice(e, pp, flags, hwnd) {
  const P = []; for (let i = 0; i < 13; i++) P.push(e.mem.r32(pp + 4 * i));
  const dev = { kind: 'device', pp: P, flags, rs: new Map(), tss: Array.from({ length: 8 }, () => new Map()), tex: new Array(8).fill(0), streams: [], indices: 0, baseIndex: 0,
    xf: new Map(), vs: 0, ps: 0, vsConst: new Float32Array(96 * 4), lights: new Map(), lightOn: new Map(), material: null, viewport: [0, 0, P[0], P[1], 0, 1],
    shaders: new Map(), shaderSeq: 0, stateBlocks: new Map(), sbSeq: 0, frame: 0, inScene: false };
  e.d3d.device = dev;
  const [, bb] = newSurface(e, P[0], P[1], P[2], 1, 0, 'backbuffer', null); dev.backbuffer = bb;
  const [, ds] = newSurface(e, P[0], P[1], P[9] || 80, 2, 0, 'depth', null); dev.depth = ds;
  dev.rt = bb; dev.zs = ds;
  const S = e.d3d.stats; const B = () => e.d3dBackend;
  const rdF = (p, n) => { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = e.mem.dv.getFloat32(p + 4 * i, true); return f; };
  const draw = (kind, args) => { S.draws++; S.drawsByKind[kind] = (S.drawsByKind[kind] || 0) + 1; return B()?.draw?.(dev, kind, args); };
  const M = [...unk(),
    ['TestCooperativeLevel', 0, () => D3D_OK], ['GetAvailableTextureMem', 0, () => 512 << 20], ['ResourceManagerDiscardBytes', 1, () => D3D_OK],
    ['GetDirect3D', 1, (e2, o, self, p) => { e2.mem.w32(p, e2.d3d.d3d8.addr); e2.d3d.d3d8.refs++; }],
    ['GetDeviceCaps', 1, (e2, o, self, p) => writeCaps(e2, p)],
    ['GetDisplayMode', 1, (e2, o, self, p) => { [P[0], P[1], P[11] || 60, P[2]].forEach((v, i) => e2.mem.w32(p + 4 * i, v)); }],
    ['GetCreationParameters', 1, (e2, o, self, p) => { [0, 1, hwnd, flags].forEach((v, i) => e2.mem.w32(p + 4 * i, v)); }],
    ['SetCursorProperties', 3, () => D3D_OK], ['SetCursorPosition', 3, () => 0], ['ShowCursor', 1, () => 0],
    ['CreateAdditionalSwapChain', 2, null],
    ['Reset', 1, (e2, o, self, p) => { for (let i = 0; i < 13; i++) P[i] = e2.mem.r32(p + 4 * i); bb.w = P[0]; bb.h = P[1]; e2.log('D3D', `Reset ${P[0]}x${P[1]}`); B()?.reset?.(o); }],
    ['Present', 4, (e2, o) => { o.frame++; S.presents++; B()?.present?.(o); e2.onPresent?.(o); }],
    ['GetBackBuffer', 3, (e2, o, self, i, type, pp) => { e2.mem.w32(pp, bb.addr); bb.refs++; }],
    ['GetRasterStatus', 1, (e2, o, self, p) => { e2.mem.w32(p, 0); e2.mem.w32(p + 4, 0); }],
    ['SetGammaRamp', 2, () => 0], ['GetGammaRamp', 1, (e2, o, self, p) => { for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) e2.mem.w16(p + c * 512 + i * 2, i * 257); }],
    ['CreateTexture', 7, (e2, o, self, w, h, lv, usage, fmt, pool, pp) => { e2.mem.w32(pp, newTexture(e2, w, h, lv, usage, fmt, pool)); }],
    ['CreateVolumeTexture', 8, null], ['CreateCubeTexture', 6, null],
    ['CreateVertexBuffer', 5, (e2, o, self, len, usage, fvf, pool, pp) => { e2.mem.w32(pp, newBuffer(e2, 'vb', len, usage, fvf, pool)); }],
    ['CreateIndexBuffer', 5, (e2, o, self, len, usage, fmt, pool, pp) => { e2.mem.w32(pp, newBuffer(e2, 'ib', len, usage, fmt, pool)); }],
    ['CreateRenderTarget', 6, (e2, o, self, w, h, fmt, ms, lockable, pp) => { const [a] = newSurface(e2, w, h, fmt, 1, 0, 'rt', null); e2.mem.w32(pp, a); }],
    ['CreateDepthStencilSurface', 5, (e2, o, self, w, h, fmt, ms, pp) => { const [a] = newSurface(e2, w, h, fmt, 2, 0, 'depth', null); e2.mem.w32(pp, a); }],
    ['CreateImageSurface', 4, (e2, o, self, w, h, fmt, pp) => { const [a] = newSurface(e2, w, h, fmt, 0, 2, 'image', null); e2.mem.w32(pp, a); }],
    ['CopyRects', 5, (e2, o, self, src, rects, n, dst, pts) => { S.copyRects++; B()?.copyRects?.(e2.d3d.objs.get(src), rects, n, e2.d3d.objs.get(dst), pts); }],
    ['UpdateTexture', 2, (e2, o, self, src, dst) => { B()?.updateTexture?.(e2.d3d.objs.get(src), e2.d3d.objs.get(dst)); }],
    ['GetFrontBuffer', 1, () => D3D_OK],
    ['SetRenderTarget', 2, (e2, o, self, rt, zs) => { if (rt) o.rt = e2.d3d.objs.get(rt); o.zs = zs ? e2.d3d.objs.get(zs) : null; B()?.setRenderTarget?.(o); }],
    ['GetRenderTarget', 1, (e2, o, self, pp) => { e2.mem.w32(pp, o.rt.addr); o.rt.refs++; }],
    ['GetDepthStencilSurface', 1, (e2, o, self, pp) => { if (!o.zs) return D3DERR_NOTAVAILABLE; e2.mem.w32(pp, o.zs.addr); o.zs.refs++; }],
    ['BeginScene', 0, (e2, o) => { o.inScene = true; B()?.beginScene?.(o); }], ['EndScene', 0, (e2, o) => { o.inScene = false; }],
    ['Clear', 6, (e2, o, self, n, rects, fl, color, z, stencil) => { S.clears++; B()?.clear?.(o, fl, color, new Float32Array(new Uint32Array([z]).buffer)[0], stencil); }],
    ['SetTransform', 2, (e2, o, self, st, p) => { o.xf.set(st, rdF(p, 16)); }],
    ['GetTransform', 2, (e2, o, self, st, p) => { const m = o.xf.get(st) || ID; for (let i = 0; i < 16; i++) e2.mem.dv.setFloat32(p + 4 * i, m[i], true); }],
    ['MultiplyTransform', 2, (e2, o, self, st, p) => { o.xf.set(st, mul(rdF(p, 16), o.xf.get(st) || ID)); }],
    ['SetViewport', 1, (e2, o, self, p) => { o.viewport = [e2.mem.r32(p), e2.mem.r32(p + 4), e2.mem.r32(p + 8), e2.mem.r32(p + 12), e2.mem.dv.getFloat32(p + 16, true), e2.mem.dv.getFloat32(p + 20, true)]; }],
    ['GetViewport', 1, (e2, o, self, p) => { const v = o.viewport; for (let i = 0; i < 4; i++) e2.mem.w32(p + 4 * i, v[i]); e2.mem.dv.setFloat32(p + 16, v[4], true); e2.mem.dv.setFloat32(p + 20, v[5], true); }],
    ['SetMaterial', 1, (e2, o, self, p) => { o.material = rdF(p, 17); }],
    ['GetMaterial', 1, (e2, o, self, p) => { const m = o.material || new Float32Array(17); for (let i = 0; i < 17; i++) e2.mem.dv.setFloat32(p + 4 * i, m[i], true); }],
    ['SetLight', 2, (e2, o, self, i, p) => { const raw = new Uint8Array(104); raw.set(e2.mem.u8.subarray(p, p + 104)); o.lights.set(i, raw); }],
    ['GetLight', 2, (e2, o, self, i, p) => { const l = o.lights.get(i); if (!l) return D3DERR_INVALIDCALL; e2.mem.u8.set(l, p); }],
    ['LightEnable', 2, (e2, o, self, i, on) => { o.lightOn.set(i, !!on); if (!o.lights.has(i)) o.lights.set(i, new Uint8Array(104)); }],
    ['GetLightEnable', 2, (e2, o, self, i, p) => { e2.mem.w32(p, o.lightOn.get(i) ? 1 : 0); }],
    ['SetClipPlane', 2, () => D3D_OK], ['GetClipPlane', 2, () => D3D_OK],
    ['SetRenderState', 2, (e2, o, self, k, v) => { o.rs.set(k, v); S.rs++; }],
    ['GetRenderState', 2, (e2, o, self, k, p) => { e2.mem.w32(p, o.rs.get(k) ?? RS_DEFAULT[k] ?? 0); }],
    ['BeginStateBlock', 0, (e2, o) => { o.recording = { rs: new Map(), tss: [], tex: [] }; }],
    ['EndStateBlock', 1, (e2, o, self, p) => { const id = ++o.sbSeq; o.stateBlocks.set(id, o.recording); o.recording = null; e2.mem.w32(p, id); }],
    ['ApplyStateBlock', 1, () => D3D_OK], ['CaptureStateBlock', 1, () => D3D_OK], ['DeleteStateBlock', 1, (e2, o, self, id) => { o.stateBlocks.delete(id); }],
    ['CreateStateBlock', 2, (e2, o, self, type, p) => { const id = ++o.sbSeq; o.stateBlocks.set(id, {}); e2.mem.w32(p, id); }],
    ['SetClipStatus', 1, () => D3D_OK], ['GetClipStatus', 1, (e2, o, self, p) => { e2.mem.w32(p, 0); e2.mem.w32(p + 4, 0); }],
    ['GetTexture', 2, (e2, o, self, st, pp) => { const t = o.tex[st]; e2.mem.w32(pp, t || 0); if (t) e2.d3d.objs.get(t).refs++; }],
    ['SetTexture', 2, (e2, o, self, st, t) => { o.tex[st] = t; S.setTex++; }],
    ['GetTextureStageState', 3, (e2, o, self, st, k, p) => { e2.mem.w32(p, o.tss[st].get(k) ?? 0); }],
    ['SetTextureStageState', 3, (e2, o, self, st, k, v) => { o.tss[st].set(k, v); }],
    ['ValidateDevice', 1, (e2, o, self, p) => { e2.mem.w32(p, 1); }], ['GetInfo', 3, () => 1],
    ['SetPaletteEntries', 2, () => D3D_OK], ['GetPaletteEntries', 2, () => D3D_OK], ['SetCurrentTexturePalette', 1, () => D3D_OK], ['GetCurrentTexturePalette', 1, (e2, o, self, p) => { e2.mem.w32(p, 0); }],
    ['DrawPrimitive', 3, (e2, o, self, type, start, count) => draw('DP', { type, start, count })],
    ['DrawIndexedPrimitive', 5, (e2, o, self, type, minIdx, numV, startIdx, count) => draw('DIP', { type, minIdx, numV, startIdx, count })],
    ['DrawPrimitiveUP', 4, (e2, o, self, type, count, data, stride) => draw('DPUP', { type, count, data, stride })],
    ['DrawIndexedPrimitiveUP', 8, (e2, o, self, type, minIdx, numV, count, idx, ifmt, data, stride) => draw('DIPUP', { type, minIdx, numV, count, idx, ifmt, data, stride })],
    ['ProcessVertices', 5, null],
    ['CreateVertexShader', 4, (e2, o, self, decl, fn, ph, usage) => {
      const d = []; for (let p = decl; ; p += 4) { const t = e2.mem.r32(p); d.push(t); if (t === 0xffffffff || d.length > 256) break; }
      const f = []; if (fn) for (let p = fn; ; p += 4) { const t = e2.mem.r32(p); f.push(t); if (t === 0x0000ffff || f.length > 8192) break; }
      const h = 0x10000 + 2 * (++o.shaderSeq); o.shaders.set(h, { decl: d, fn: f.length ? f : null }); e2.mem.w32(ph, h); S.vshaders++;
      e2.log('D3D', `CreateVertexShader #${o.shaderSeq}: decl ${d.length} tokens, ${f.length ? 'código ' + f.length + ' tokens (vs ' + ((f[0] >> 8) & 255) + '.' + (f[0] & 255) + ')' : 'sin código (FF)'}`); }],
    ['SetVertexShader', 1, (e2, o, self, h) => { o.vs = h; }], ['GetVertexShader', 1, (e2, o, self, p) => { e2.mem.w32(p, o.vs); }],
    ['DeleteVertexShader', 1, (e2, o, self, h) => { o.shaders.delete(h); }],
    ['SetVertexShaderConstant', 3, (e2, o, self, reg, p, n) => { for (let i = 0; i < n * 4; i++) o.vsConst[reg * 4 + i] = e2.mem.dv.getFloat32(p + 4 * i, true); }],
    ['GetVertexShaderConstant', 3, (e2, o, self, reg, p, n) => { for (let i = 0; i < n * 4; i++) e2.mem.dv.setFloat32(p + 4 * i, o.vsConst[reg * 4 + i], true); }],
    ['GetVertexShaderDeclaration', 3, null], ['GetVertexShaderFunction', 3, null],
    ['SetStreamSource', 3, (e2, o, self, n, vb, stride) => { o.streams[n] = { vb, stride }; }],
    ['GetStreamSource', 3, (e2, o, self, n, pp, ps) => { const s = o.streams[n] || { vb: 0, stride: 0 }; e2.mem.w32(pp, s.vb); e2.mem.w32(ps, s.stride); if (s.vb) e2.d3d.objs.get(s.vb).refs++; }],
    ['SetIndices', 2, (e2, o, self, ib, base) => { o.indices = ib; o.baseIndex = base; }],
    ['GetIndices', 2, (e2, o, self, pp, pb) => { e2.mem.w32(pp, o.indices); e2.mem.w32(pb, o.baseIndex); if (o.indices) e2.d3d.objs.get(o.indices).refs++; }],
    ['CreatePixelShader', 2, (e2, o, self, fn, ph) => { const f = []; for (let p = fn; ; p += 4) { const t = e2.mem.r32(p); f.push(t); if (t === 0x0000ffff || f.length > 4096) break; }
      const h = 0x20000 + (++o.shaderSeq); o.shaders.set(h, { ps: f }); e2.mem.w32(ph, h); S.pshaders++; e2.log('D3D', `CreatePixelShader ps ${(f[0] >> 8) & 255}.${f[0] & 255}, ${f.length} tokens`); }],
    ['SetPixelShader', 1, (e2, o, self, h) => { o.ps = h; }], ['GetPixelShader', 1, (e2, o, self, p) => { e2.mem.w32(p, o.ps); }],
    ['DeletePixelShader', 1, (e2, o, self, h) => { o.shaders.delete(h); }],
    ['SetPixelShaderConstant', 3, () => D3D_OK], ['GetPixelShaderConstant', 3, () => D3D_OK], ['GetPixelShaderFunction', 3, null],
    ['DrawRectPatch', 3, null], ['DrawTriPatch', 3, null], ['DeletePatch', 1, null],
  ];
  if (M.length !== 97) throw new Error(`IDirect3DDevice8: ${M.length} métodos (deben ser 97)`);
  return makeCom(e, 'IDirect3DDevice8', M, dev);
}
const ID = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b) { const r = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; r[i * 4 + j] = s; } return r; }
const RS_DEFAULT = { 7: 1, 8: 3, 9: 2, 14: 1, 15: 0, 19: 2, 20: 1, 22: 3, 23: 4, 27: 0, 137: 1 };
function writeCaps(e, p) {
  e.mem.fill(p, 0, 212); const W = (o, v) => e.mem.w32(p + o, v); const F = (o, v) => e.mem.dv.setFloat32(p + o, v, true);
  W(0, 1); W(8, 0x20000); W(12, 0xE0000000); W(16, 0x20); W(20, 0x8000000F); W(24, 3);
  W(28, 0x001BFEF0); W(32, 0x2FF2); W(36, 0x0F732191); W(40, 0xFF); W(44, 0x1FFF); W(48, 0x1FFF); W(52, 0xFF); W(56, 0x42A4A);
  W(60, 0x0001EC45); W(64, 0x03030700); W(68, 0x0303); W(72, 0x0303); W(76, 0x3F); W(80, 0x3F); W(84, 0x1F);
  W(88, 4096); W(92, 4096); W(96, 512); W(100, 8192); W(104, 8192); W(108, 16);
  F(112, 1e10); F(116, -1e8); F(120, -1e8); F(124, 1e8); F(128, 1e8); F(132, 0);
  W(136, 0xFF); W(140, 0x00080008); W(144, 0x03FFFFFF); W(148, 8); W(152, 4); W(156, 0x3B); W(160, 8); W(164, 6);
  W(168, 4); W(172, 0); F(176, 64); W(180, 0xFFFFF); W(184, 0xFFFFFF); W(188, 16); W(192, 255);
  W(196, 0xFFFE0101); W(200, 96); W(204, 0xFFFF0104); F(208, 8);
}

// ---------- IDirect3D8 ----------
export const D3D8 = {
  Direct3DCreate8: api(1, (emu, sdk) => {
    emu.log('D3D', `Direct3DCreate8(${sdk}) en instr=${emu.cpu.icount}`);
    emu.d3d = { objs: new Map(), stats: { textures: 0, texBytes: 0, locks: 0, bufLocks: 0, draws: 0, drawsByKind: {}, presents: 0, clears: 0, rs: 0, setTex: 0, copyRects: 0, vshaders: 0, pshaders: 0 }, formats: {}, texSeq: 0, bufSeq: 0 };
    const o = {};
    const a = makeCom(emu, 'IDirect3D8', [...unk(),
      ['RegisterSoftwareDevice', 1, () => D3DERR_INVALIDCALL], ['GetAdapterCount', 0, () => 1],
      ['GetAdapterIdentifier', 3, (e, oo, self, ad, fl, p) => { e.mem.fill(p, 0, 1068); e.mem.writeCStr(p, 'webgl2.dll', 512); e.mem.writeCStr(p + 512, 'WebGL2 (Chrome)', 512); e.mem.w32(p + 1032, 0x10de); ADAPTER_GUID.forEach((b, k) => e.mem.w8(p + 1048 + k, b)); }],
      ['GetAdapterModeCount', 1, () => MODES.length],
      ['EnumAdapterModes', 3, (e, oo, self, ad, i, p) => { const v = MODES[i]; if (!v) return D3DERR_INVALIDCALL; v.forEach((x, k) => e.mem.w32(p + 4 * k, x)); }],
      ['GetAdapterDisplayMode', 2, (e, oo, self, ad, p) => { [1920, 1080, 60, 22].forEach((x, k) => e.mem.w32(p + 4 * k, x)); }],
      ['CheckDeviceType', 5, () => D3D_OK],
      ['CheckDeviceFormat', 6, (e, oo, self, ad, dt, afmt, usage, rtype, fmt) => (surfSize(fmt, 4, 4) || fmt === 101 || fmt === 102 ? D3D_OK : D3DERR_NOTAVAILABLE)],
      ['CheckDeviceMultiSampleType', 5, (e, oo, self, ad, dt, fmt, win, ms) => (ms === 0 ? D3D_OK : D3DERR_NOTAVAILABLE)],
      ['CheckDepthStencilMatch', 5, () => D3D_OK],
      ['GetDeviceCaps', 3, (e, oo, self, ad, dt, p) => writeCaps(e, p)],
      ['GetMonitor', 1, () => 0x12340000],
      ['CreateDevice', 6, (e, oo, self, ad, dt, hwnd, flags, pp, out) => {
        e.log('D3D', `CreateDevice flags=0x${flags.toString(16)} en instr=${e.cpu.icount}`); e.onMilestone?.('CreateDevice');
        e.mem.w32(out, createDevice(e, pp, flags, hwnd)); }],
    ], o);
    emu.d3d.d3d8 = o;
    return a;
  }),
};
