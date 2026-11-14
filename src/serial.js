// serial.js — serializador binario portable (Node y navegador) con referencias compartidas y ciclos.
// Soporta: undefined, null, boolean, number, string, Array, objetos planos, Map, Set, ArrayBuffer y typed arrays.
const T = { UNDEF: 0, NULL: 1, TRUE: 2, FALSE: 3, NUM: 4, STR: 5, ARR: 6, OBJ: 7, MAP: 8, SET: 9, AB: 10, TA: 11, REF: 12, INT: 13 };
const TAS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
const enc = new TextEncoder(), dec = new TextDecoder();
export function serialize(value) {
  let buf = new Uint8Array(1 << 20), dv = new DataView(buf.buffer), n = 0; const refs = new Map();
  const need = (k) => { if (n + k <= buf.length) return; let s = buf.length * 2; while (s < n + k) s *= 2; const b = new Uint8Array(s); b.set(buf); buf = b; dv = new DataView(buf.buffer); };
  const u8 = (v) => { need(1); buf[n++] = v; }; const u32 = (v) => { need(4); dv.setUint32(n, v, true); n += 4; };
  const f64 = (v) => { need(8); dv.setFloat64(n, v, true); n += 8; };
  const bytes = (b) => { u32(b.length); need(b.length); buf.set(b, n); n += b.length; };
  const str = (s) => bytes(enc.encode(s));
  const w = (v) => {
    if (v === undefined) return u8(T.UNDEF); if (v === null) return u8(T.NULL);
    if (v === true) return u8(T.TRUE); if (v === false) return u8(T.FALSE);
    if (typeof v === 'number') { if (Number.isInteger(v) && v >= -2147483648 && v <= 4294967295 && !Object.is(v, -0)) { u8(T.INT); f64(v); } else { u8(T.NUM); f64(v); } return; }
    if (typeof v === 'string') { u8(T.STR); return str(v); }
    if (typeof v === 'function') throw new Error('serialize: función');
    if (refs.has(v)) { u8(T.REF); return u32(refs.get(v)); }
    refs.set(v, refs.size);
    if (v instanceof ArrayBuffer) { u8(T.AB); return bytes(new Uint8Array(v)); }
    if (ArrayBuffer.isView(v)) { u8(T.TA); u8(TAS.findIndex((C) => v instanceof C)); return bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); }
    if (Array.isArray(v)) { u8(T.ARR); u32(v.length); for (const x of v) w(x); return; }
    if (v instanceof Map) { u8(T.MAP); u32(v.size); for (const [k, x] of v) { w(k); w(x); } return; }
    if (v instanceof Set) { u8(T.SET); u32(v.size); for (const x of v) w(x); return; }
    u8(T.OBJ); const ks = Object.keys(v).filter((k) => typeof v[k] !== 'function'); u32(ks.length); for (const k of ks) { str(k); w(v[k]); }
  };
  w(value); return buf.slice(0, n);
}
export function deserialize(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); let n = 0; const refs = [];
  const u8 = () => b[n++]; const u32 = () => { const v = dv.getUint32(n, true); n += 4; return v; }; const f64 = () => { const v = dv.getFloat64(n, true); n += 8; return v; };
  const bytes = () => { const l = u32(); const s = b.subarray(n, n + l); n += l; return s; };
  const str = () => dec.decode(bytes());
  const r = () => {
    const t = u8();
    switch (t) {
      case T.UNDEF: return undefined; case T.NULL: return null; case T.TRUE: return true; case T.FALSE: return false;
      case T.INT: case T.NUM: return f64(); case T.STR: return str(); case T.REF: return refs[u32()];
      case T.AB: { const s = bytes(); const a = new ArrayBuffer(s.length); new Uint8Array(a).set(s); refs.push(a); return a; }
      case T.TA: { const C = TAS[u8()]; const s = bytes(); const a = new ArrayBuffer(s.length); new Uint8Array(a).set(s); const v = new C(a); refs.push(v); return v; }
      case T.ARR: { const a = []; refs.push(a); const l = u32(); for (let i = 0; i < l; i++) a.push(r()); return a; }
      case T.MAP: { const m = new Map(); refs.push(m); const l = u32(); for (let i = 0; i < l; i++) { const k = r(); m.set(k, r()); } return m; }
      case T.SET: { const s = new Set(); refs.push(s); const l = u32(); for (let i = 0; i < l; i++) s.add(r()); return s; }
      case T.OBJ: { const o = {}; refs.push(o); const l = u32(); for (let i = 0; i < l; i++) { const k = str(); o[k] = r(); } return o; }
    }
    throw new Error('deserialize: tipo ' + t + ' en ' + (n - 1));
  };
  return r();
}
