// simd.js — MMX, SSE y SSE2 para el intérprete x86 (perfil "CPU moderna": sin 3DNow!, sin SSSE3/SSE4/AVX).
// Registros: 8 MMX de 64 bits y 8 XMM de 128 bits sobre ArrayBuffers (little-endian).
// Floats de precisión simple: Math.fround sobre el resultado en double (redondeo IEEE correcto para +,-,*,/,sqrt).
// MXCSR: se guarda y se respeta el modo de redondeo en las conversiones; FTZ/DAZ se registran pero no se aplican.

const RC_NEAREST = 0;
function roundMode(v, rc) {
  if (rc === 0) { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
  if (rc === 1) return Math.floor(v); if (rc === 2) return Math.ceil(v); return Math.trunc(v);
}
const I32_IND = -2147483648;
function toI32(v, rc) { if (!Number.isFinite(v)) return I32_IND; const r = roundMode(v, rc); return (r >= 2147483648 || r < -2147483648) ? I32_IND : r | 0; }
const satS8 = (v) => v > 127 ? 127 : v < -128 ? -128 : v;
const satU8 = (v) => v > 255 ? 255 : v < 0 ? 0 : v;
const satS16 = (v) => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
const satU16 = (v) => v > 65535 ? 65535 : v < 0 ? 0 : v;


// ---- redondeo dirigido (MXCSR.RC != nearest) con transformaciones exactas ----
const _f64 = new Float64Array(1), _u64 = new BigUint64Array(_f64.buffer), _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
function next64(x, up) { if (Number.isNaN(x)) return x; if (x === 0) return up ? 5e-324 : -5e-324; _f64[0] = x; _u64[0] += ((x > 0) === up) ? 1n : -1n; return _f64[0]; }
function next32(x, up) { if (Number.isNaN(x)) return x; if (x === 0) return up ? 1.401298464324817e-45 : -1.401298464324817e-45; _f32[0] = x; _u32[0] += ((x > 0) === up) ? 1 : -1; return _f32[0]; }
function twoSum(a, b) { const s = a + b, bb = s - a, e = (a - (s - bb)) + (b - bb); return [s, e]; }
const SPLIT = 134217729;
function twoProd(a, b) { const p = a * b; if (!Number.isFinite(p)) return [p, 0];
  let t = SPLIT * a; const ah = t - (t - a), al = a - ah; t = SPLIT * b; const bh = t - (t - b), bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl]; }
// valor exacto del resultado como hi+lo (o signo del residuo)
function exact(op, a, b) {
  switch (op) {
    case 0x58: return twoSum(a, b); case 0x5c: return twoSum(a, -b); case 0x59: return twoProd(a, b);
    case 0x5e: { const q = a / b; if (!Number.isFinite(q) || q === 0) return [q, 0]; const [p, pe] = twoProd(q, b); const r = (a - p) - pe; return [q, (r / b) || 0]; }
    case 0x51: { const q = Math.sqrt(b); if (!Number.isFinite(q) || q === 0) return [q, 0]; const [p, pe] = twoProd(q, q); const r = (b - p) - pe; return [q, (r / (2 * q)) || 0]; }
  }
  return null;
}
// redondea el valor exacto (hi+lo) al formato pedido según rc (1=abajo 2=arriba 3=hacia cero)
function directed(hi, lo, dbl, rc) {
  if (Number.isNaN(hi)) return hi;
  let c = dbl ? hi : Math.fround(hi); const d = dbl ? lo : (hi - c) + lo; // d = verdadero - candidato
  if (!Number.isFinite(c) && Number.isFinite(hi + lo) === false && dbl) return c;
  const nx = dbl ? next64 : next32;
  if (!Number.isFinite(c) && !dbl && Number.isFinite(hi)) { // desborde en float32
    if (rc === 3 || (rc === 1 && c > 0) || (rc === 2 && c < 0)) return nx(c, c < 0); return c; }
  if (d === 0) return c;
  const wantDown = rc === 1 || (rc === 3 && c > 0); const wantUp = rc === 2 || (rc === 3 && c < 0);
  if (d < 0 && wantDown) return nx(c, false);
  if (d > 0 && wantUp) return nx(c, true);
  return c;
}

export class SIMD {
  constructor(cpu) {
    this.cpu = cpu;
    this.xbuf = new ArrayBuffer(128); this.mbuf = new ArrayBuffer(64);
    this.mxcsr = 0x1f80;
    this.t1 = new Uint8Array(16); this.t2 = new Uint8Array(16); this.t3 = new Uint8Array(16);
  }
  cvtF(x) { const rc = (this.mxcsr >> 13) & 3; return rc === 0 ? Math.fround(x) : directed(x, 0, false, rc); }
  // ---- acceso a operandos ----
  xr(i) { return new Uint8Array(this.xbuf, i * 16, 16); }
  mr(i) { return new Uint8Array(this.mbuf, i * 8, 8); }
  reg(isX, i) { return isX ? this.xr(i) : this.mr(i); }
  rdMem(addr, n, out) { const m = this.cpu.mem; for (let i = 0; i < n; i += 4) { const v = m.r32(addr + i); out[i] = v; out[i + 1] = v >>> 8; out[i + 2] = v >>> 16; out[i + 3] = v >>> 24; } return out; }
  wrMem(addr, src, n) { const m = this.cpu.mem; for (let i = 0; i < n; i += 4) m.w32(addr + i, src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)); }
  // operando fuente r/m de n bytes (copia en t2)
  src(isX, n) { const c = this.cpu; const t = this.t2; t.fill(0); if (c.mMod === 3) t.set(this.reg(isX, c.mRm).subarray(0, n)); else this.rdMem(c.mAddr, n, t); return t; }
  static v(u8, T) { return new T(u8.buffer, u8.byteOffset, u8.byteLength / T.BYTES_PER_ELEMENT); }

  // ---- ejecución: devuelve true si manejó el opcode 0F xx ----
  exec(op) {
    const c = this.cpu; const pfx = c.rep === 0xf3 ? 3 : c.rep === 0xf2 ? 2 : c.opsize === 2 ? 1 : 0; // 1=66 2=F2 3=F3
    const X = pfx !== 0 || (op >= 0x10 && op <= 0x17) || (op >= 0x28 && op <= 0x2f && op !== 0x2a && op !== 0x2c && op !== 0x2d) || (op >= 0x50 && op <= 0x5f) || op === 0xc2 || op === 0xc6;
    const V = SIMD.v;
    switch (op) {
      // ======== movimientos SSE/SSE2 ========
      case 0x10: case 0x11: { c.modrm(); const n = pfx === 3 ? 4 : pfx === 2 ? 8 : 16; const d = this.xr(c.mReg);
        if (op === 0x10) { if (c.mMod === 3) { if (n === 16) d.set(this.xr(c.mRm)); else d.set(this.xr(c.mRm).subarray(0, n)); } else { const t = this.rdMem(c.mAddr, n, this.t2); d.fill(0); d.set(t.subarray(0, n)); } }
        else { if (c.mMod === 3) this.xr(c.mRm).set(d.subarray(0, n)); else this.wrMem(c.mAddr, d, n); }
        return true; }
      case 0x12: case 0x13: case 0x16: case 0x17: { c.modrm(); const d = this.xr(c.mReg); const hi = op >= 0x16;
        if (op === 0x12 || op === 0x16) { if (c.mMod === 3) { const s = this.xr(c.mRm); if (op === 0x12) d.set(s.slice(8, 16), 0); else d.set(s.slice(0, 8), 8); } else { const t = this.rdMem(c.mAddr, 8, this.t2); d.set(t.subarray(0, 8), hi ? 8 : 0); } }
        else this.wrMem(c.mAddr, d.subarray(hi ? 8 : 0), 8);
        return true; }
      case 0x14: case 0x15: { c.modrm(); const s = this.src(true, 16).slice(); const d = this.xr(c.mReg); const a = d.slice();
        if (pfx === 1) { const o = op === 0x14 ? 0 : 8; d.set(a.subarray(o, o + 8), 0); d.set(s.subarray(o, o + 8), 8); }
        else { const o = op === 0x14 ? 0 : 8; d.set(a.subarray(o, o + 4), 0); d.set(s.subarray(o, o + 4), 4); d.set(a.subarray(o + 4, o + 8), 8); d.set(s.subarray(o + 4, o + 8), 12); }
        return true; }
      case 0x18: c.modrm(); return true; // prefetch
      case 0x28: case 0x29: { c.modrm(); const d = this.xr(c.mReg);
        if (op === 0x28) d.set(this.src(true, 16).slice()); else if (c.mMod === 3) this.xr(c.mRm).set(d); else this.wrMem(c.mAddr, d, 16); return true; }
      case 0x2a: { c.modrm();
        if (pfx === 3 || pfx === 2) { const v = c.mMod === 3 ? c.r[c.mRm] | 0 : c.mem.r32(c.mAddr) | 0; const d = this.xr(c.mReg); if (pfx === 3) V(d, Float32Array)[0] = this.cvtF(v); else V(d, Float64Array)[0] = v; }
        else { const s = V(this.src(false, 8), Int32Array); const d = this.xr(c.mReg); if (pfx === 1) { const f = V(d, Float64Array); f[0] = s[0]; f[1] = s[1]; } else { const f = V(d, Float32Array); f[0] = Math.fround(s[0]); f[1] = Math.fround(s[1]); } }
        return true; }
      case 0x2c: case 0x2d: { c.modrm(); const rc = op === 0x2c ? 3 : (this.mxcsr >> 13) & 3;
        if (pfx === 3 || pfx === 2) { const s = this.src(true, 8); const v = pfx === 3 ? V(s, Float32Array)[0] : V(s, Float64Array)[0]; c.r[c.mReg] = toI32(v, rc) >>> 0; }
        else { const s = this.src(true, 16); const d = V(this.mr(c.mReg), Int32Array); if (pfx === 1) { const f = V(s, Float64Array); d[0] = toI32(f[0], rc); d[1] = toI32(f[1], rc); } else { const f = V(s, Float32Array); d[0] = toI32(f[0], rc); d[1] = toI32(f[1], rc); } }
        return true; }
      case 0x2e: case 0x2f: { c.modrm(); const s = this.src(true, 8); const d = this.xr(c.mReg);
        const a = pfx === 1 ? V(d, Float64Array)[0] : V(d, Float32Array)[0]; const b = pfx === 1 ? V(s, Float64Array)[0] : V(s, Float32Array)[0];
        if (Number.isNaN(a) || Number.isNaN(b)) { c.zf = 1; c.pf = 1; c.cf = 1; } else { c.zf = a === b ? 1 : 0; c.pf = 0; c.cf = a < b ? 1 : 0; }
        c.of = 0; c.sf = 0; c.af = 0; if (c.lazy !== undefined) c.lazy = 0; return true; }
      case 0x50: { c.modrm(); const s = this.xr(c.mRm); let m = 0;
        if (pfx === 1) { m = (s[7] >> 7) | ((s[15] >> 7) << 1); } else for (let i = 0; i < 4; i++) m |= (s[i * 4 + 3] >> 7) << i;
        c.r[c.mReg] = m; return true; }
      case 0x51: case 0x52: case 0x53: case 0x58: case 0x59: case 0x5c: case 0x5d: case 0x5e: case 0x5f: { c.modrm();
        const scal = pfx >= 2; const dbl = pfx === 1 || pfx === 2; const s = this.src(true, scal ? (dbl ? 8 : 4) : 16).slice(); const d = this.xr(c.mReg);
        const T = dbl ? Float64Array : Float32Array; const A = V(d, T), B = V(s, T); const n = scal ? 1 : A.length; const R = dbl ? (x) => x : Math.fround;
        const W = dbl ? 8 : 4; const rc = (this.mxcsr >> 13) & 3;
        for (let i = 0; i < n; i++) { const a = A[i], b = B[i]; const unary = op === 0x51 || op === 0x52 || op === 0x53;
          // NaN de entrada: x86 devuelve el NaN del primer operando (quieto); min/max devuelven el segundo
          if (op === 0x5d || op === 0x5f) { const takeB = Number.isNaN(a) || Number.isNaN(b) || (a === 0 && b === 0) || (op === 0x5d ? !(a < b) : !(a > b)); if (takeB) d.set(s.subarray(i * W, i * W + W), i * W); continue; }
          if ((!unary && Number.isNaN(a)) || Number.isNaN(b)) { const srcU = (!unary && Number.isNaN(a)) ? d.slice(i * W, i * W + W) : s.subarray(i * W, i * W + W); d.set(srcU, i * W); d[i * W + W - 1 - (dbl ? 0 : 0)] |= 0; d[i * W + (dbl ? 6 : 2)] |= dbl ? 0x08 : 0x40; continue; }
          let r;
          switch (op) {
            case 0x51: r = Math.sqrt(b); break; case 0x52: r = 1 / Math.sqrt(b); break; case 0x53: r = 1 / b; break;
            case 0x58: r = a + b; break; case 0x59: r = a * b; break; case 0x5c: r = a - b; break; case 0x5e: r = a / b; break; }
          if (Number.isNaN(r)) { if (dbl) { d.fill(0, i * 8, i * 8 + 6); d[i * 8 + 6] = 0xf8; d[i * 8 + 7] = 0xff; } else { d[i * 4] = 0; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0xc0; d[i * 4 + 3] = 0xff; } continue; }
          if (rc !== 0 && (op === 0x51 || op === 0x58 || op === 0x59 || op === 0x5c || op === 0x5e)) {
            const [h, l] = exact(op, a, b); let v = directed(h, l, dbl, rc);
            if (v === 0 && (op === 0x58 || op === 0x5c) && rc === 1) { const sa = Object.is(a, -0) || a < 0, sb = (op === 0x5c) !== (Object.is(b, -0) || b < 0); if (sa !== sb || (sa && sb)) v = -0; }
            A[i] = v;
          } else A[i] = R(r); }
        return true; }
      case 0x54: case 0x55: case 0x56: case 0x57: case 0xdb: case 0xdf: case 0xeb: case 0xef: { c.modrm();
        const isX = X || pfx === 1; const n = isX ? 16 : 8; const s = this.src(isX, n).slice(); const d = this.reg(isX, c.mReg);
        for (let i = 0; i < n; i++) { const a = d[i], b = s[i];
          d[i] = (op === 0x54 || op === 0xdb) ? a & b : (op === 0x55 || op === 0xdf) ? (~a) & b : (op === 0x56 || op === 0xeb) ? a | b : a ^ b; }
        return true; }
      case 0x5a: { c.modrm(); const d = this.xr(c.mReg);
        if (pfx === 3) { const s = this.src(true, 4); V(d, Float64Array)[0] = V(s, Float32Array)[0]; }
        else if (pfx === 2) { const s = this.src(true, 8); V(d, Float32Array)[0] = this.cvtF(V(s, Float64Array)[0]); }
        else if (pfx === 1) { const s = V(this.src(true, 16).slice(), Float64Array); const f = V(d, Float32Array); f[0] = this.cvtF(s[0]); f[1] = this.cvtF(s[1]); f[2] = 0; f[3] = 0; }
        else { const s = V(this.src(true, 8).slice(), Float32Array); const f = V(d, Float64Array); f[0] = s[0]; f[1] = s[1]; }
        return true; }
      case 0x5b: { c.modrm(); const s = this.src(true, 16).slice(); const d = this.xr(c.mReg);
        if (pfx === 0) { const a = V(s, Int32Array), f = V(d, Float32Array); for (let i = 0; i < 4; i++) f[i] = this.cvtF(a[i]); }
        else { const a = V(s, Float32Array), o = V(d, Int32Array); const rc = pfx === 3 ? 3 : (this.mxcsr >> 13) & 3; for (let i = 0; i < 4; i++) o[i] = toI32(a[i], rc); }
        return true; }
      case 0xc2: { c.modrm(); const scal = pfx >= 2; const dbl = pfx === 1 || pfx === 2; const s = this.src(true, scal ? (dbl ? 8 : 4) : 16).slice(); const imm = c.f8() & 7;
        const d = this.xr(c.mReg); const T = dbl ? Float64Array : Float32Array; const A = V(d, T), B = V(s, T); const I = V(d, dbl ? Uint32Array : Uint32Array);
        const n = scal ? 1 : A.length;
        for (let i = 0; i < n; i++) { const a = A[i], b = B[i]; const un = Number.isNaN(a) || Number.isNaN(b); let t;
          switch (imm) { case 0: t = a === b; break; case 1: t = a < b; break; case 2: t = a <= b; break; case 3: t = un; break; case 4: t = !(a === b); break; case 5: t = !(a < b); break; case 6: t = !(a <= b); break; default: t = !un; }
          const v = t ? 0xffffffff : 0; if (dbl) { I[i * 2] = v; I[i * 2 + 1] = v; } else I[i] = v; }
        return true; }
      case 0xc6: { c.modrm(); const s = this.src(true, 16).slice(); const imm = c.f8(); const d = this.xr(c.mReg); const a = d.slice();
        if (pfx === 1) { d.set(a.subarray((imm & 1) * 8, (imm & 1) * 8 + 8), 0); d.set(s.subarray(((imm >> 1) & 1) * 8, ((imm >> 1) & 1) * 8 + 8), 8); }
        else { const A = V(a, Uint32Array), B = V(s, Uint32Array), D = V(d, Uint32Array); D[0] = A[imm & 3]; D[1] = A[(imm >> 2) & 3]; D[2] = B[(imm >> 4) & 3]; D[3] = B[(imm >> 6) & 3]; }
        return true; }
      case 0xae: { c.modrm(); const g = c.mReg;
        if (c.mMod === 3) return true; // lfence/mfence/sfence
        if (g === 2) { this.mxcsr = c.mem.r32(c.mAddr); return true; }
        if (g === 3) { c.mem.w32(c.mAddr, this.mxcsr); return true; }
        if (g === 7) return true; // clflush
        return false; }
      // ======== MMX / SSE2 enteros ========
      case 0x6e: { c.modrm(); const v = c.mMod === 3 ? c.r[c.mRm] : c.mem.r32(c.mAddr); const d = this.reg(pfx === 1, c.mReg); d.fill(0); V(d, Uint32Array)[0] = v; return true; }
      case 0x7e: { c.modrm();
        if (pfx === 3) { const s = this.src(true, 8).slice(); const d = this.xr(c.mReg); d.fill(0); d.set(s.subarray(0, 8)); return true; }
        const v = V(this.reg(pfx === 1, c.mReg), Uint32Array)[0]; if (c.mMod === 3) c.r[c.mRm] = v; else c.mem.w32(c.mAddr, v); return true; }
      case 0x6f: { c.modrm(); const isX = pfx !== 0; const s = this.src(isX, isX ? 16 : 8).slice(); this.reg(isX, c.mReg).set(s.subarray(0, isX ? 16 : 8)); return true; }
      case 0x7f: { c.modrm(); const isX = pfx !== 0; const d = this.reg(isX, c.mReg); if (c.mMod === 3) this.reg(isX, c.mRm).set(d); else this.wrMem(c.mAddr, d, isX ? 16 : 8); return true; }
      case 0xd6: { c.modrm(); if (pfx !== 1) return false; const s = this.xr(c.mReg); if (c.mMod === 3) { const d = this.xr(c.mRm); d.fill(0, 8); d.set(s.subarray(0, 8)); } else this.wrMem(c.mAddr, s, 8); return true; }
      case 0xe7: case 0x2b: { c.modrm(); const isX = op === 0x2b || pfx === 1; this.wrMem(c.mAddr, this.reg(isX, c.mReg), isX ? 16 : 8); return true; }
      case 0x77: return true; // emms
      case 0x70: { c.modrm(); const isX = pfx !== 0; const s = this.src(isX, isX ? 16 : 8).slice(); const imm = c.f8(); const d = this.reg(isX, c.mReg);
        if (!isX) { const S = V(s, Uint16Array), D = V(d, Uint16Array); for (let i = 0; i < 4; i++) D[i] = S[(imm >> (2 * i)) & 3]; }
        else if (pfx === 1) { const S = V(s, Uint32Array), D = V(d, Uint32Array); for (let i = 0; i < 4; i++) D[i] = S[(imm >> (2 * i)) & 3]; }
        else { const S = V(s, Uint16Array), D = V(d, Uint16Array); const o = pfx === 3 ? 4 : 0; D.set(S); for (let i = 0; i < 4; i++) D[o + i] = S[o + ((imm >> (2 * i)) & 3)]; }
        return true; }
      case 0x71: case 0x72: case 0x73: { c.modrm(); const isX = pfx === 1; const imm = c.f8(); const d = this.reg(isX, c.mRm); const g = c.mReg;
        if (op === 0x73 && (g === 3 || g === 7)) { const a = d.slice(); const n = Math.min(imm, 16); d.fill(0); if (g === 3) d.set(a.subarray(n), 0); else d.set(a.subarray(0, 16 - n), n); return true; }
        const lane = op === 0x71 ? 2 : op === 0x72 ? 4 : 8; this.shift(d, lane, g === 2 ? 'r' : g === 4 ? 'a' : 'l', imm); return true; }
      case 0xd1: case 0xd2: case 0xd3: case 0xe1: case 0xe2: case 0xf1: case 0xf2: case 0xf3: { c.modrm(); const isX = pfx === 1; const s = this.src(isX, isX ? 16 : 8);
        const cnt = V(s, Uint32Array)[1] ? 1e9 : V(s, Uint32Array)[0]; const d = this.reg(isX, c.mReg);
        const lane = [2, 4, 8][(op & 0xf) - 1]; const kind = op < 0xe0 ? 'r' : op < 0xf0 ? 'a' : 'l'; this.shift(d, lane, kind, cnt); return true; }
      case 0xc4: { c.modrm(); const v = (c.mMod === 3 ? c.r[c.mRm] : c.mem.r16(c.mAddr)) & 0xffff; const imm = c.f8(); const d = this.reg(pfx === 1, c.mReg); const D = V(d, Uint16Array); D[imm & (D.length - 1)] = v; return true; }
      case 0xc5: { c.modrm(); const imm = c.f8(); const s = this.reg(pfx === 1, c.mRm); const S = V(s, Uint16Array); c.r[c.mReg] = S[imm & (S.length - 1)]; return true; }
      case 0xd7: { c.modrm(); const s = this.reg(pfx === 1, c.mRm); let m = 0; for (let i = 0; i < s.length; i++) m |= (s[i] >> 7) << i; c.r[c.mReg] = m; return true; }
      case 0xe6: { c.modrm(); if (pfx === 0) return false; const s = this.src(true, 16).slice(); const d = this.xr(c.mReg);
        if (pfx === 3) { const a = V(s, Int32Array); const f = V(d, Float64Array); const x0 = a[0], x1 = a[1]; f[0] = x0; f[1] = x1; }
        else { const f = V(s, Float64Array); const o = V(d, Int32Array); const rc = pfx === 1 ? 3 : (this.mxcsr >> 13) & 3; o[0] = toI32(f[0], rc); o[1] = toI32(f[1], rc); o[2] = 0; o[3] = 0; }
        return true; }
      case 0x6c: case 0x6d: { c.modrm(); if (pfx !== 1) return false; const s = this.src(true, 16).slice(); const d = this.xr(c.mReg); const o = op === 0x6c ? 0 : 8; const a = d.slice(); d.set(a.subarray(o, o + 8), 0); d.set(s.subarray(o, o + 8), 8); return true; }
    }
    // ---- aritmética entera empaquetada (genérica) ----
    const P = PACKED[op];
    if (P) { c.modrm(); const isX = pfx === 1; const n = isX ? 16 : 8; const s = this.src(isX, n).slice(); const d = this.reg(isX, c.mReg); P(d, s, n); return true; }
    return false;
  }
  shift(d, lane, kind, cnt) {
    const V = SIMD.v; const bits = lane * 8;
    if (lane === 8) { const D = V(d, BigUint64Array); for (let i = 0; i < D.length; i++) D[i] = cnt >= 64 ? 0n : kind === 'l' ? (D[i] << BigInt(cnt)) & 0xffffffffffffffffn : D[i] >> BigInt(cnt); return; }
    const T = lane === 2 ? (kind === 'a' ? Int16Array : Uint16Array) : (kind === 'a' ? Int32Array : Uint32Array); const D = V(d, T);
    for (let i = 0; i < D.length; i++) { const x = D[i];
      if (kind === 'a') D[i] = cnt >= bits ? (x < 0 ? -1 : 0) : x >> cnt;
      else if (cnt >= bits) D[i] = 0; else D[i] = kind === 'l' ? x << cnt : (lane === 4 ? x >>> cnt : x >> cnt); }
  }
}
// Tabla de operaciones enteras empaquetadas: (dest, src, nbytes) — mismas para MMX (8) y XMM (16 con 66h)
const V = SIMD.v;
const lanes = (T, f) => (d, s) => { const D = V(d, T), S = V(s, T); for (let i = 0; i < D.length; i++) D[i] = f(D[i], S[i]); };
const PACKED = {
  0x60: (d, s, n) => unpack(d, s, n, 1, 0), 0x61: (d, s, n) => unpack(d, s, n, 2, 0), 0x62: (d, s, n) => unpack(d, s, n, 4, 0),
  0x68: (d, s, n) => unpack(d, s, n, 1, 1), 0x69: (d, s, n) => unpack(d, s, n, 2, 1), 0x6a: (d, s, n) => unpack(d, s, n, 4, 1),
  0x63: (d, s, n) => pack(d, s, Int16Array, Int8Array, satS8), 0x67: (d, s, n) => pack(d, s, Int16Array, Uint8Array, satU8), 0x6b: (d, s, n) => pack(d, s, Int32Array, Int16Array, satS16),
  0x64: lanes(Int8Array, (a, b) => a > b ? -1 : 0), 0x65: lanes(Int16Array, (a, b) => a > b ? -1 : 0), 0x66: lanes(Int32Array, (a, b) => a > b ? -1 : 0),
  0x74: lanes(Uint8Array, (a, b) => a === b ? 255 : 0), 0x75: lanes(Uint16Array, (a, b) => a === b ? 65535 : 0), 0x76: lanes(Uint32Array, (a, b) => a === b ? 0xffffffff : 0),
  0xd4: (d, s) => { const D = V(d, BigUint64Array), S = V(s, BigUint64Array); for (let i = 0; i < D.length; i++) D[i] = D[i] + S[i]; },
  0xfb: (d, s) => { const D = V(d, BigUint64Array), S = V(s, BigUint64Array); for (let i = 0; i < D.length; i++) D[i] = D[i] - S[i]; },
  0xd5: lanes(Int16Array, (a, b) => Math.imul(a, b)), 0xe5: lanes(Int16Array, (a, b) => (a * b) >> 16), 0xe4: lanes(Uint16Array, (a, b) => (a * b) >>> 16),
  0xd8: lanes(Uint8Array, (a, b) => satU8(a - b)), 0xd9: lanes(Uint16Array, (a, b) => satU16(a - b)), 0xdc: lanes(Uint8Array, (a, b) => satU8(a + b)), 0xdd: lanes(Uint16Array, (a, b) => satU16(a + b)),
  0xda: lanes(Uint8Array, (a, b) => Math.min(a, b)), 0xde: lanes(Uint8Array, (a, b) => Math.max(a, b)), 0xea: lanes(Int16Array, (a, b) => Math.min(a, b)), 0xee: lanes(Int16Array, (a, b) => Math.max(a, b)),
  0xe0: lanes(Uint8Array, (a, b) => (a + b + 1) >> 1), 0xe3: lanes(Uint16Array, (a, b) => (a + b + 1) >> 1),
  0xe8: lanes(Int8Array, (a, b) => satS8(a - b)), 0xe9: lanes(Int16Array, (a, b) => satS16(a - b)), 0xec: lanes(Int8Array, (a, b) => satS8(a + b)), 0xed: lanes(Int16Array, (a, b) => satS16(a + b)),
  0xf8: lanes(Uint8Array, (a, b) => a - b), 0xf9: lanes(Uint16Array, (a, b) => a - b), 0xfa: lanes(Uint32Array, (a, b) => a - b),
  0xfc: lanes(Uint8Array, (a, b) => a + b), 0xfd: lanes(Uint16Array, (a, b) => a + b), 0xfe: lanes(Uint32Array, (a, b) => a + b),
  0xf4: (d, s) => { const D = V(d, Uint32Array), S = V(s, Uint32Array), Q = V(d, BigUint64Array); for (let i = 0; i < Q.length; i++) Q[i] = BigInt(D[i * 2]) * BigInt(S[i * 2]); },
  0xf5: (d, s) => { const D = V(d, Int16Array), S = V(s, Int16Array), R = V(d, Int32Array); const out = []; for (let i = 0; i < D.length; i += 2) out.push((D[i] * S[i] + D[i + 1] * S[i + 1]) | 0); out.forEach((v, i) => R[i] = v); },
  0xf6: (d, s, n) => { const out = []; for (let o = 0; o < n; o += 8) { let t = 0; for (let i = 0; i < 8; i++) t += Math.abs(d[o + i] - s[o + i]); out.push(t); } d.fill(0); out.forEach((t, k) => { d[k * 8] = t & 255; d[k * 8 + 1] = t >> 8; }); },
};
function unpack(d, s, n, w, high) { const a = d.slice(); const half = n / 2, off = high ? half : 0; let k = 0;
  for (let i = 0; i < half; i += w) { for (let j = 0; j < w; j++) d[k++] = a[off + i + j]; for (let j = 0; j < w; j++) d[k++] = s[off + i + j]; } }
function pack(d, s, Tin, Tout, sat) { const A = V(d.slice(), Tin), B = V(s, Tin); const O = V(d, Tout); const n = A.length; for (let i = 0; i < n; i++) O[i] = sat(A[i]); for (let i = 0; i < n; i++) O[n + i] = sat(B[i]); }

export const SIMD_OPS = new Uint8Array(256);
for (const o of [0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x28,0x29,0x2a,0x2b,0x2c,0x2d,0x2e,0x2f,0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x5b,0x5c,0x5d,0x5e,0x5f,0x6c,0x6d,0x6e,0x6f,0x70,0x71,0x72,0x73,0x77,0x7e,0x7f,0xae,0xc2,0xc4,0xc5,0xc6,0xd1,0xd2,0xd3,0xd6,0xd7,0xdb,0xdf,0xe1,0xe2,0xe6,0xe7,0xeb,0xef,0xf1,0xf2,0xf3]) SIMD_OPS[o] = 1;
for (const k of Object.keys(PACKED)) SIMD_OPS[+k] = 1;
