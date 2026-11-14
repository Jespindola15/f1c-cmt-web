// accel.js — aceleradores: rutinas calientes del F1C_CMT.exe reimplementadas en JS nativo (HLE de funciones).
// No se modifica ningún archivo: se instala un hook en la entrada de la función dentro de la memoria emulada.
// Cada acelerador verifica primero los bytes de la rutina original; si no coinciden, no se instala.
// La semántica replica exactamente la rutina (incluidos los efectos en variables globales y los bucles do-while).

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
    const plain = key === 0xffffffff; const k = key & 0xffffff;
    m.w32(0x5dd844, plain ? 1 : 0); m.w32(0x5dd804, k); m.w32(0x5dd814, w);
    const rows = h > 0 ? h : 1, u32 = m.u32; const cp = m.codePages;
    let s = src, d = dst;
    for (let y = 0; y < rows; y++) {
      if (cp[d >>> 12] || cp[(d + w * 4) >>> 12]) { // destino con código compilado (no ocurre en la práctica): ruta segura
        const cols = plain ? w : (w > 0 ? w : 1);
        for (let x = 0; x < cols; x++) { const v = m.r32(s + 4 * x); if (plain || v !== k) m.w32(d + 4 * x, v); }
      } else if (plain) { if (w > 0) u32.copyWithin(d >>> 2, s >>> 2, (s >>> 2) + w); }
      else { const cols = w > 0 ? w : 1; let si = s >>> 2, di = d >>> 2; for (let x = 0; x < cols; x++, si++, di++) { const v = u32[si]; if (v !== k) u32[di] = v; } }
      s = (s + sPitch) >>> 0; d = (d + dPitch) >>> 0;
    }
    c.icount += 20 + rows * (plain ? 8 : 6 * (w > 0 ? w : 1));
    return ret(c, m);
  } };

export const ACCELS = [BLIT32];
export function installAccel(emu, list = ACCELS) {
  const out = [];
  for (const A of list) {
    if (!matches(emu.mem, A.addr, A.sig)) { out.push(`${A.name}: firma distinta, no instalado`); continue; }
    emu.addHook(A.addr, () => A.fn(emu)); out.push(A.name);
  }
  return out;
}
