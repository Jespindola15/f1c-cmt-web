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
function x87Transform(emu, v, out, M, coord) {
  const f = emu.cpu.fpu, m = emu.mem, ST = f.st, TG = f.tagEmpty;
  const rf = (a) => ((a & 3) === 0 && a >= 4096 && a < m.size ? m.f32a[a >>> 2] : m.f32(a));
  const V0 = rf(v), V1 = rf(v + 4), V2 = rf(v + 8);
  let t = f.top, i, x;
  // fld/fmul x6
  t = (t - 1) & 7; ST[t] = rf(M) * V0; TG[t] = 0; t = (t - 1) & 7; ST[t] = rf(M + 4) * V0; TG[t] = 0; t = (t - 1) & 7; ST[t] = rf(M + 8) * V0; TG[t] = 0;
  t = (t - 1) & 7; ST[t] = rf(M + 16) * V1; TG[t] = 0; t = (t - 1) & 7; ST[t] = rf(M + 20) * V1; TG[t] = 0; t = (t - 1) & 7; ST[t] = rf(M + 24) * V1; TG[t] = 0;
  // fxch st2; faddp st5; faddp st3; faddp st1
  i = (t + 2) & 7; x = ST[t]; ST[t] = ST[i]; ST[i] = x;
  i = (t + 5) & 7; ST[i] = ST[i] + ST[t]; TG[t] = 1; t = (t + 1) & 7;
  i = (t + 3) & 7; ST[i] = ST[i] + ST[t]; TG[t] = 1; t = (t + 1) & 7;
  i = (t + 1) & 7; ST[i] = ST[i] + ST[t]; TG[t] = 1; t = (t + 1) & 7;
  t = (t - 1) & 7; ST[t] = rf(M + 32) * V2; TG[t] = 0; t = (t - 1) & 7; ST[t] = rf(M + 36) * V2; TG[t] = 0; t = (t - 1) & 7; ST[t] = rf(M + 40) * V2; TG[t] = 0;
  i = (t + 2) & 7; x = ST[t]; ST[t] = ST[i]; ST[i] = x;
  i = (t + 5) & 7; ST[i] = ST[i] + ST[t]; TG[t] = 1; t = (t + 1) & 7;
  i = (t + 3) & 7; ST[i] = ST[i] + ST[t]; TG[t] = 1; t = (t + 1) & 7;
  i = (t + 1) & 7; ST[i] = ST[i] + ST[t]; TG[t] = 1; t = (t + 1) & 7;
  const wf = (a, val) => { if ((a & 3) === 0 && a >= 4096 && a < m.size && m.fastW(a)) m.f32a[a >>> 2] = val; else m.wf32(a, val); };
  if (coord) {
    i = (t + 2) & 7; x = ST[t]; ST[t] = ST[i]; ST[i] = x; ST[t] = ST[t] + rf(M + 48);
    i = (t + 1) & 7; x = ST[t]; ST[t] = ST[i]; ST[i] = x; ST[t] = ST[t] + rf(M + 52);
    i = (t + 2) & 7; x = ST[t]; ST[t] = ST[i]; ST[i] = x; ST[t] = ST[t] + rf(M + 56);
    i = (t + 1) & 7; x = ST[t]; ST[t] = ST[i]; ST[i] = x;
    wf(out, ST[t]); TG[t] = 1; t = (t + 1) & 7; wf(out + 8, ST[t]); TG[t] = 1; t = (t + 1) & 7; wf(out + 4, ST[t]); TG[t] = 1; t = (t + 1) & 7;
  } else { wf(out + 8, ST[t]); TG[t] = 1; t = (t + 1) & 7; wf(out + 4, ST[t]); TG[t] = 1; t = (t + 1) & 7; wf(out, ST[t]); TG[t] = 1; t = (t + 1) & 7; }
  f.top = t;
}
// marco de la función llamada (push ebp/esi/edi/eax/ebx/ecx/edx) debajo de `sp` (= esp al entrar, apunta al retorno)
function calleeFrame(m, r, sp) { m.w32(sp - 4, r[5]); m.w32(sp - 8, r[6]); m.w32(sp - 12, r[7]); m.w32(sp - 16, r[0]); m.w32(sp - 20, r[3]); m.w32(sp - 24, r[1]); m.w32(sp - 28, r[2]); }
const XSIG = (tail) => hex('55 8b ec 56 57 50 53 51 52 8b 75 08 8b 7d 0c 8b 45 10 d9 00 d8 0e d9 40 04 d8 0e d9 40 08 d8 0e' + tail);
function xformCallee(coord, n) {
  return (emu) => { const c = emu.cpu, m = emu.mem, r = c.r, sp = r[4];
    const v = m.r32(sp + 4), out = m.r32(sp + 8), M = m.r32(sp + 12);
    calleeFrame(m, r, sp); x87Transform(emu, v, out, M, coord); c.icount += n; return ret(c, m); };
}
function xformWrapper(coord, retAddr, n) {
  return (emu) => { const c = emu.cpu, m = emu.mem, r = c.r, sp = r[4];
    const p1 = m.r32(sp + 8), p2 = m.r32(sp + 12), p3 = m.r32(sp + 16);
    r[0] = p3; r[1] = p2; r[2] = p1; m.w32(sp - 4, p3); m.w32(sp - 8, p2); m.w32(sp - 12, p1); m.w32(sp - 16, retAddr);
    calleeFrame(m, r, sp - 16); x87Transform(emu, p1, p2, p3, coord); c.icount += n; return ret(c, m); };
}
const XNORM = { addr: 0x55ef24, sig: XSIG(''), name: 'TransformNormal x87', fn: xformCallee(false, 48) };
const XCOORD = { addr: 0x55eeaf, sig: XSIG(''), name: 'TransformCoord x87', fn: xformCallee(true, 55) };
const WNORM = { addr: 0x53bea0, sig: hex('8b 44 24 10 8b 4c 24 0c 8b 54 24 08 50 51 52 e8 70 30 02 00 83 c4 0c c3'), name: 'envoltorio TransformNormal', fn: xformWrapper(false, 0x53beb4, 48 + 9) };
const WCOORD = { addr: 0x53bec0, sig: hex('8b 44 24 10 8b 4c 24 0c 8b 54 24 08 50 51 52 e8 db 2f 02 00 83 c4 0c c3'), name: 'envoltorio TransformCoord', fn: xformWrapper(true, 0x53bed4, 55 + 9) };

// Las transformaciones x87 quedan disponibles pero no se instalan: el JIT con regiones las ejecuta igual de rápido.
export const ACCELS = [BLIT32];
export const ACCELS_ALL = [BLIT32, XNORM, XCOORD, WNORM, WCOORD];
export function installAccel(emu, list = ACCELS) {
  const out = [];
  for (const A of list) {
    if (!matches(emu.mem, A.addr, A.sig)) { out.push(`${A.name}: firma distinta, no instalado`); continue; }
    emu.addHook(A.addr, () => A.fn(emu)); out.push(A.name);
  }
  return out;
}
