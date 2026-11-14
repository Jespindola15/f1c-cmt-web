// accel.js — aceleradores: rutinas calientes del F1C_CMT.exe reimplementadas en JS nativo (HLE de funciones).
// No se modifica ningún archivo: se instala un hook en la entrada de la función dentro de la memoria emulada.
// Cada acelerador verifica primero los bytes de la rutina original; si no coinciden, no se instala.
// La semántica replica exactamente la rutina (incluidos los efectos en variables globales y los bucles do-while).

import { WASM_ACCEL_B64 } from './wasm-accel.js';
let wasmModule = null;
function wasmFor(m) {
  if (!m.wasmMem || m.noWasm) return null;
  if (m._wasm === undefined) { try { wasmModule ??= new WebAssembly.Module(Uint8Array.from(atob(WASM_ACCEL_B64), (ch) => ch.charCodeAt(0))); m._wasm = new WebAssembly.Instance(wasmModule, { e: { mem: m.wasmMem } }).exports; } catch { m._wasm = null; } }
  return m._wasm;
}
const hex = (s) => s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16));
function matches(mem, addr, bytes) { for (let i = 0; i < bytes.length; i++) if (mem.u8[addr + i] !== bytes[i]) return false; return true; }
const ret = (c, m, nargs = 0) => { c.eip = m.r32(c.r[4]); c.r[4] = (c.r[4] + 4) >>> 0; return false; };

// 0x560a82: blit32(src, srcPitch, dst, dstPitch, w, h, colorKey) — composición del menú (cdecl).
// colorKey == -1: copia; si no, copia los píxeles cuyo dword != (colorKey & 0xffffff).
const BLIT32 = { addr: 0x560a82, sig: hex('55 8b ec 56 57 60 fc 8b 45 20 c7 05 44 d8 5d 00 00 00 00 00 83 f8 ff 75 0a'), name: 'blit32 (menú)',
  fn(emu) {
    const c = emu.cpu, m = emu.mem, sp = c.r[4];
    const src = m.r32(sp + 4), sPitch = m.r32(sp + 8) | 0, dst = m.r32(sp + 12), dPitch = m.r32(sp + 16) | 0, w = m.r32(sp + 20) | 0, h = m.r32(sp + 24) | 0, key = m.r32(sp + 28);
    if ((src | dst | sPitch | dPitch) & 3) return true; // caso no alineado: ejecutar la rutina original
    // marco de la rutina original: push ebp/esi/edi y pushal (eax ecx edx ebx esp ebp esi edi)
    const r = c.r; m.w32(sp - 4, r[5]); m.w32(sp - 8, r[6]); m.w32(sp - 12, r[7]);
    [r[0], r[1], r[2], r[3], (sp - 12) >>> 0, (sp - 4) >>> 0, r[6], r[7]].forEach((v, i) => m.w32(sp - 16 - 4 * i, v));
    const plain = key === 0xffffffff; const k = key & 0xffffff;
    m.w32(0x5dd844, plain ? 1 : 0); m.w32(0x5dd804, k); m.w32(0x5dd814, w);
    const rows = h > 0 ? h : 1, u32 = m.u32; const cp = m.codePages; const cols = plain ? w : (w > 0 ? w : 1);
    let s = src, d = dst, writes = 0;
    const W = !plain && wasmFor(m);
    if (W) { // ruta SIMD: sólo si ninguna página destino tiene código compilado y todo está dentro de la memoria
      const last = dst + (rows - 1) * dPitch, end = last + cols * 4; const sEnd = src + (rows - 1) * sPitch + cols * 4; let ok = dPitch >= 0 && sPitch >= 0 && end <= m.size && sEnd <= m.size && (end <= src || sEnd <= dst);
      for (let p = dst >>> 12; ok && p <= (end - 1) >>> 12; p++) if (cp[p]) ok = false;
      if (ok) { writes = W.blitKey(src, sPitch, dst, dPitch, cols, rows, k) >>> 0; c.icount += 19 + 6 * rows + 6 * rows * cols + writes + 6; return ret(c, m); }
    }
    for (let y = 0; y < rows; y++) {
      if (cp[d >>> 12] || cp[(d + cols * 4) >>> 12]) { // destino con código compilado (no ocurre en la práctica): ruta segura
        for (let x = 0; x < cols; x++) { const v = m.r32(s + 4 * x); if (plain || v !== k) { m.w32(d + 4 * x, v); writes++; } }
      } else if (plain) { if (w > 0) u32.copyWithin(d >>> 2, s >>> 2, (s >>> 2) + w); }
      else { let si = s >>> 2, di = d >>> 2; for (let x = 0; x < cols; x++, si++, di++) { const v = u32[si]; if (v !== k) { u32[di] = v; writes++; } } }
      s = (s + sPitch) >>> 0; d = (d + dPitch) >>> 0;
    }
    // mismas instrucciones que la rutina original (el reloj virtual de las pruebas depende de esto)
    c.icount += plain ? 27 + 6 * rows + 6 : 19 + 6 * rows + 6 * rows * cols + writes + 6;
    return ret(c, m);
  } };

// Transformaciones vec3 x matriz 4x4 en x87 (las usa la iluminación/reflejos por vértice del menú y del juego):
//   0x55ef24 TransformNormal(v, out, M)   0x55eeaf TransformCoord(v, out, M)   (cdecl, guardan todos los registros)
//   0x53bea0 / 0x53bec0: envoltorios de la tabla de funciones matemáticas (this, v, out, M).
// Se reproduce la misma secuencia de operaciones x87 sobre la FPU emulada (mismo orden de sumas, mismos
// valores residuales en la pila) y las mismas escrituras en la pila del programa.
// Lectura/escritura de float32 sin cierres (rápidas en el caso alineado)
function rf(m, a) { return (a & 3) === 0 && a >= 4096 && a < 2147483648 ? m.f32a[a >>> 2] : m.f32(a); }
function wf(m, a, v) { if ((a & 3) === 0 && a >= 4096 && a < 2147483648 && m.codePages[a >>> 12] === 0 && m.noFastW !== true) m.f32a[a >>> 2] = v; else m.wf32(a, v); }
function w32(m, a, v) { if ((a & 3) === 0 && a >= 4096 && a < 2147483648 && m.codePages[a >>> 12] === 0 && m.noFastW !== true) m.u32[a >>> 2] = v; else m.w32(a, v); }
function x87Transform(emu, v, out, M, coord) {
  const f = emu.cpu.fpu, m = emu.mem, ST = f.st, TG = f.tagEmpty;
  const V0 = rf(m, v), V1 = rf(m, v + 4), V2 = rf(m, v + 8);
  const p0 = rf(m, M) * V0, p1 = rf(m, M + 4) * V0, p2 = rf(m, M + 8) * V0, p4 = rf(m, M + 16) * V1, p5 = rf(m, M + 20) * V1, p6 = rf(m, M + 24) * V1;
  const q8 = rf(m, M + 32) * V2, q9 = rf(m, M + 36) * V2, q10 = rf(m, M + 40) * V2;
  // misma secuencia que el x87: x=(p0+p4)+q8, y=(p1+p5)+q9, z=(p2+p6)+q10 (+ traslación)
  let x = p0 + p4, y = p1 + p5, z = p2 + p6; x = x + q8; y = y + q9; z = z + q10;
  const t = f.top;
  if (coord) { x = x + rf(m, M + 48); y = y + rf(m, M + 52); z = z + rf(m, M + 56); }
  // valores que la secuencia fld/fxch/faddp/fstp deja en los registros físicos (tags vacíos, mismo tope)
  if (coord) { ST[(t - 1) & 7] = y; ST[(t - 2) & 7] = z; ST[(t - 3) & 7] = x; } else { ST[(t - 1) & 7] = x; ST[(t - 2) & 7] = y; ST[(t - 3) & 7] = z; }
  ST[(t - 4) & 7] = q10; ST[(t - 5) & 7] = q9; ST[(t - 6) & 7] = q8;
  for (let i = 1; i <= 6; i++) TG[(t - i) & 7] = 1;
  if (coord) { wf(m, out, x); wf(m, out + 8, z); wf(m, out + 4, y); } else { wf(m, out + 8, z); wf(m, out + 4, y); wf(m, out, x); }
}
// marco de la función llamada (push ebp/esi/edi/eax/ebx/ecx/edx) debajo de `sp` (= esp al entrar, apunta al retorno)
function calleeFrame(m, r, sp) { w32(m, sp - 4, r[5]); w32(m, sp - 8, r[6]); w32(m, sp - 12, r[7]); w32(m, sp - 16, r[0]); w32(m, sp - 20, r[3]); w32(m, sp - 24, r[1]); w32(m, sp - 28, r[2]); }
const XSIG = (tail) => hex('55 8b ec 56 57 50 53 51 52 8b 75 08 8b 7d 0c 8b 45 10 d9 00 d8 0e d9 40 04 d8 0e d9 40 08 d8 0e' + tail);
function xformCallee(coord, n) {
  return (emu) => { const c = emu.cpu, m = emu.mem, r = c.r, sp = r[4];
    const v = m.r32(sp + 4), out = m.r32(sp + 8), M = m.r32(sp + 12);
    calleeFrame(m, r, sp); x87Transform(emu, v, out, M, coord); c.icount += n; return ret(c, m); };
}
function xformWrapper(coord, retAddr, n) {
  return (emu) => { const c = emu.cpu, m = emu.mem, r = c.r, sp = r[4];
    const p1 = m.r32(sp + 8), p2 = m.r32(sp + 12), p3 = m.r32(sp + 16);
    r[0] = p3; r[1] = p2; r[2] = p1; w32(m, sp - 4, p3); w32(m, sp - 8, p2); w32(m, sp - 12, p1); w32(m, sp - 16, retAddr);
    calleeFrame(m, r, sp - 16); x87Transform(emu, p1, p2, p3, coord); c.icount += n; return ret(c, m); };
}
const XNORM = { addr: 0x55ef24, sig: XSIG(''), name: 'TransformNormal x87', fn: xformCallee(false, 48) };
const XCOORD = { addr: 0x55eeaf, sig: XSIG(''), name: 'TransformCoord x87', fn: xformCallee(true, 55) };
const WNORM = { addr: 0x53bea0, sig: hex('8b 44 24 10 8b 4c 24 0c 8b 54 24 08 50 51 52 e8 70 30 02 00 83 c4 0c c3'), name: 'envoltorio TransformNormal', fn: xformWrapper(false, 0x53beb4, 48 + 9) };
const WCOORD = { addr: 0x53bec0, sig: hex('8b 44 24 10 8b 4c 24 0c 8b 54 24 08 50 51 52 e8 db 2f 02 00 83 c4 0c c3'), name: 'envoltorio TransformCoord', fn: xformWrapper(true, 0x53bed4, 55 + 9) };

// 0x58924c: swap(a, b, ancho) del qsort de la CRT (intercambio byte a byte). Usado al ordenar en la carga de
// pistas (generación del .HAT). Registros finales y escrituras de pila idénticos a la rutina original.
const QSWAP = { addr: 0x58924c, sig: hex('8b 44 24 04 8b 4c 24 08 3b c1 56 74 1d 8b 54 24 10 8b f2 4a 85 f6 74 12 53 8d 72 01 8a 19 8a 10 88 18 40 88 11 41 4e 75 f3 5b 5e c3'), name: 'qsort swap (CRT)',
  fn(emu) {
    const c = emu.cpu, m = emu.mem, r = c.r, sp = r[4];
    const a = m.r32(sp + 4), b = m.r32(sp + 8), w = m.r32(sp + 12);
    w32(m, sp - 4, r[6]); // push esi
    if (a === b) { r[0] = a; r[1] = b; c.icount += 7; c.zf = 1; c.cf = 0; c.sf = 0; c.of = 0; c.pf = 1; c.af = 0; return ret(c, m); }
    if (w === 0) { r[0] = a; r[1] = b; r[2] = 0xffffffff; c.icount += 12; c.zf = 1; c.cf = 0; c.sf = 0; c.of = 0; c.pf = 1; return ret(c, m); }
    w32(m, sp - 8, r[3]); // push ebx
    let last = m.r8(a + w - 1);
    const u8 = m.u8, cp = m.codePages;
    const overlap = !(a + w <= b || b + w <= a);
    if (!overlap && !cp[a >>> 12] && !cp[(a + w - 1) >>> 12] && !cp[b >>> 12] && !cp[(b + w - 1) >>> 12] && m.noFastW !== true && a >= 4096 && b >= 4096 && a + w <= m.size && b + w <= m.size) {
      if (w <= 64) { for (let i = 0; i < w; i++) { const t = u8[a + i]; u8[a + i] = u8[b + i]; u8[b + i] = t; } }
      else { const t = u8.slice(a, a + w); u8.copyWithin(a, b, b + w); u8.set(t, b); }
    } else { let y = 0; for (let i = 0; i < w; i++) { const x = m.r8(b + i); y = m.r8(a + i); m.w8(a + i, x); m.w8(b + i, y); } last = y; }
    r[0] = (a + w) >>> 0; r[1] = (b + w) >>> 0; r[2] = (((w - 1) & 0xffffff00) | last) >>> 0;
    c.icount += 15 + 8 * w; c.zf = 1; c.sf = 0; c.of = 0; c.pf = 1; c.af = 0;
    return ret(c, m);
  } };
// Las transformaciones x87 quedan disponibles pero no se instalan: el JIT con regiones las ejecuta igual de rápido.
export const ACCELS = [BLIT32, QSWAP];
export const ACCELS_ALL = [BLIT32, QSWAP, XNORM, XCOORD, WNORM, WCOORD];
export function installAccel(emu, list = ACCELS) {
  const out = [];
  for (const A of list) {
    if (!matches(emu.mem, A.addr, A.sig)) { out.push(`${A.name}: firma distinta, no instalado`); continue; }
    emu.addHook(A.addr, () => A.fn(emu)); out.push(A.name);
  }
  return out;
}
