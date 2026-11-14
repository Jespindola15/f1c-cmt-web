// memory.js — memoria plana de 32 bits respaldada por un ArrayBuffer.
// Mapa de direcciones del prototipo:
//   0x00010000  TEB / PEB / bloques del "sistema"
//   0x00100000  zona de thunks de API (EIP aquí => llamada a JS)
//   0x00400000  imagen principal (ImageBase de DAYTONA.EXE)
//   0x02000000+ DLLs cargadas por LoadLibrary (con relocación)
//   0x03000000  heap (HeapAlloc/VirtualAlloc/GlobalAlloc/superficies DirectDraw)
//   0x0F000000-0x0FFF0000 pila del hilo principal
export const MEM_SIZE = 0x80000000; // 2 GiB = espacio de usuario de Win32 (F1C CMT: pistas con texturas)
export const TEB_ADDR = 0x00010000;
export const PEB_ADDR = 0x00011000;
export const SYS_ADDR = 0x00012000; // strings del sistema (cmdline, env, etc.)
export const THUNK_BASE = 0x00100000;
export const THUNK_END = 0x00110000;
export const HOST_RETURN = THUNK_END - 4; // dirección mágica: vuelta de callback a JS
export const DLL_BASE = 0x02000000;
export const HEAP_BASE = 0x03000000;
export const HEAP_END = 0x3f000000;
// segundo tramo del heap, por encima de la pila (la pila del hilo principal queda en 0x3f800000-0x3fff0000)
export const HEAP2_BASE = 0x40000000, HEAP2_END = 0x7f000000;
export const STACK_TOP = 0x3fff0000;
export const STACK_SIZE = 0x00800000;

export class MemFault extends Error {
  constructor(addr, kind) { super(`Acceso inválido a memoria (${kind}) en 0x${(addr >>> 0).toString(16)}`); this.addr = addr; }
}

export class Memory {
  constructor(size = MEM_SIZE) {
    // Memoria de WebAssembly (si existe) para que las rutinas SIMD de accel.js trabajen sobre ella sin copias
    if (typeof WebAssembly !== 'undefined' && size >= 0x40000000) { this.wasmMem = new WebAssembly.Memory({ initial: size >>> 16, maximum: size >>> 16 }); this.buf = this.wasmMem.buffer; }
    else this.buf = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
    // vistas alineadas para las rutas rápidas (host little-endian, como x86)
    this.u16 = new Uint16Array(this.buf); this.u32 = new Uint32Array(this.buf); this.f32a = new Float32Array(this.buf); this.f64a = new Float64Array(this.buf);
    this.size = size;
    this.heapPtr = HEAP_BASE;
    this.blocks = new Map(); // addr -> size (para HeapSize/ReAlloc)
    this.freeBlocks = new Map(); // addr -> tamaño (bloques libres)
    // vigilancia de escrituras en un rango (la usa el reescalado 3D para saber quién pintó cada píxel)
    this.watchLo = 0; this.watchHi = 0; this.onWatch = null;
  }
  // escritura sin efectos secundarios: página sin código compilado, sin pines ni vigilancia
  fastW(a) { const cp = this.codePages; return cp !== undefined && cp[a >>> 12] === 0 && this.noFastW !== true; }
  chk(a, n, k) { if (a < 0x1000 || a + n > this.size) throw new MemFault(a, k); }
  r8(a) { a >>>= 0; if (a < 0x1000 || a >= this.size) throw new MemFault(a, 'lectura'); return this.u8[a]; }
  r16(a) { a >>>= 0; if ((a & 1) === 0 && a >= 0x1000 && a < this.size) return this.u16[a >>> 1]; this.chk(a, 2, 'lectura'); return this.u8[a] | (this.u8[a + 1] << 8); }
  r32(a) { a >>>= 0; if ((a & 3) === 0 && a >= 0x1000 && a < this.size) return this.u32[a >>> 2]; this.chk(a, 4, 'lectura'); return (this.u8[a] | (this.u8[a + 1] << 8) | (this.u8[a + 2] << 16) | (this.u8[a + 3] << 24)) >>> 0; }
  // Si la página contiene código ya compilado por el JIT, se invalidan sus bloques
  // ---- pines: valores de 32 bits que el juego no puede modificar (autos remotos del multijugador) ----
  pin(a, v) {
    a >>>= 0;
    if (!this.pinPages) { this.pinPages = new Uint8Array(this.size >>> 12); this.pins = new Map(); }
    this.noFastW = true; // con pines activos, toda escritura pasa por la ruta lenta
    this.pins.set(a, v >>> 0); this.pinPages[a >>> 12] = 1; this.pinPages[(a + 3) >>> 12] = 1;
    this.u8[a] = v; this.u8[a + 1] = v >>> 8; this.u8[a + 2] = v >>> 16; this.u8[a + 3] = v >>> 24;
  }
  unpin(a) { if (this.pins) this.pins.delete(a >>> 0); }
  unpinAll() { if (this.pins) { this.pins.clear(); this.pinPages.fill(0); } }
  repin(a, n) {
    for (let p = (a & ~3) - 4, e = a + n; p < e; p += 4) {
      const v = this.pins.get(p >>> 0);
      if (v !== undefined) { this.u8[p] = v; this.u8[p + 1] = v >>> 8; this.u8[p + 2] = v >>> 16; this.u8[p + 3] = v >>> 24; }
    }
  }
  pw(a, n) { const pp = this.pinPages; if (!pp) return; for (let p = a >>> 12, e = (a + n - 1) >>> 12; p <= e; p++) if (pp[p]) { this.repin(a, n); return; } }
  cw(a, n) { const cp = this.codePages; if (!cp) return; for (let p = a >>> 12, e = (a + n - 1) >>> 12; p <= e; p++) if (cp[p]) this.onCodeWrite(p); }
  w8(a, v) { a >>>= 0; if (a < 0x1000 || a >= this.size) throw new MemFault(a, 'escritura'); if (a < this.watchHi && a >= this.watchLo) this.onWatch(a, 1); if (this.codePages && this.codePages[a >>> 12]) this.onCodeWrite(a >>> 12); this.u8[a] = v; if (this.pinPages && this.pinPages[a >>> 12]) this.repin(a, 1); }
  w16(a, v) { a >>>= 0; if ((a & 1) === 0 && a >= 0x1000 && a < this.size && this.fastW(a)) { this.u16[a >>> 1] = v; return; } this.chk(a, 2, 'escritura'); if (a < this.watchHi && a >= this.watchLo) this.onWatch(a, 2); if (this.codePages && this.codePages[a >>> 12]) this.onCodeWrite(a >>> 12); this.u8[a] = v; this.u8[a + 1] = v >>> 8; if (this.pinPages && this.pinPages[a >>> 12]) this.repin(a, 2); }
  w32(a, v) { a >>>= 0; if ((a & 3) === 0 && a >= 0x1000 && a < this.size && this.fastW(a)) { this.u32[a >>> 2] = v; return; } this.chk(a, 4, 'escritura'); if (a < this.watchHi && a >= this.watchLo) this.onWatch(a, 4); if (this.codePages && this.codePages[a >>> 12]) this.onCodeWrite(a >>> 12); this.u8[a] = v; this.u8[a + 1] = v >>> 8; this.u8[a + 2] = v >>> 16; this.u8[a + 3] = v >>> 24; if (this.pinPages && this.pinPages[a >>> 12]) this.repin(a, 4); }
  f32(a) { a >>>= 0; if ((a & 3) === 0 && a >= 0x1000 && a < this.size) return this.f32a[a >>> 2]; this.chk(a, 4, 'lectura'); return this.dv.getFloat32(a, true); }
  f64(a) { a >>>= 0; if ((a & 7) === 0 && a >= 0x1000 && a < this.size) return this.f64a[a >>> 3]; this.chk(a, 8, 'lectura'); return this.dv.getFloat64(a, true); }
  wf32(a, v) { a >>>= 0; if ((a & 3) === 0 && a >= 0x1000 && a < this.size && this.fastW(a)) { this.f32a[a >>> 2] = v; return; } this.chk(a, 4, 'escritura'); this.cw(a, 4); this.dv.setFloat32(a, v, true); this.pw(a, 4); }
  wf64(a, v) { a >>>= 0; if ((a & 7) === 0 && a >= 0x1000 && a < this.size && this.fastW(a)) { this.f64a[a >>> 3] = v; return; } this.chk(a, 8, 'escritura'); this.cw(a, 8); this.dv.setFloat64(a, v, true); this.pw(a, 8); }
  cstr(a, max = 4096) {
    if (!a) return null;
    let s = '';
    for (let i = 0; i < max; i++) { const c = this.r8(a + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  wstr(a, max = 4096) {
    if (!a) return null;
    let s = '';
    for (let i = 0; i < max; i++) { const c = this.r16(a + i * 2); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  writeCStr(a, s, max = Infinity) {
    const n = Math.min(s.length, max - 1);
    for (let i = 0; i < n; i++) this.u8[a + i] = s.charCodeAt(i) & 0xff;
    this.cw(a, n + 1);
    this.u8[a + n] = 0;
    return n;
  }
  writeBytes(a, bytes) { this.chk(a, bytes.length, 'escritura'); if (a < this.watchHi && a + bytes.length > this.watchLo) this.onWatch(a, bytes.length); this.cw(a, bytes.length); this.u8.set(bytes, a); this.pw(a, bytes.length); }
  fill(a, v, n) { this.chk(a, n, 'escritura'); if (a < this.watchHi && a + n > this.watchLo) this.onWatch(a, n); this.cw(a, n); this.u8.fill(v, a, a + n); this.pw(a, n); }
  copy(dst, src, n) { this.chk(dst, n, 'escritura'); if (dst < this.watchHi && dst + n > this.watchLo) this.onWatch(dst, n); this.cw(dst, n); this.chk(src, n, 'lectura'); this.u8.copyWithin(dst, src, src + n); this.pw(dst, n); }

  // Asignador: bump + bloques libres con fusión de vecinos y bins por potencia de 2 (determinista).
  // freeBlocks: addr -> tamaño (se guarda en las instantáneas); bins/freeEnd se reconstruyen.
  binOf(n) { return 31 - Math.clz32(n); }
  ensureFree() {
    if (this.bins) return;
    this.bins = Array.from({ length: 32 }, () => new Set()); this.freeEnd = new Map();
    if (!this.freeBlocks) this.freeBlocks = new Map();
    if (this.freeList) { const old = this.freeList; this.freeList = undefined; for (const [n, l] of old) for (const a of l) this.addFree(a, n); } // formato viejo
    else { const fb = this.freeBlocks; this.freeBlocks = new Map(); for (const [a, n] of fb) this.addFree(a, n); }
  }
  addFree(a, n) {
    // fusionar con el bloque libre anterior y el siguiente
    const prev = this.freeEnd.get(a); if (prev !== undefined) { const pn = this.freeBlocks.get(prev); this.removeFree(prev, pn); a = prev; n += pn; }
    const nn = this.freeBlocks.get(a + n); if (nn !== undefined) { this.removeFree(a + n, nn); n += nn; }
    if (a + n === this.heapPtr) { this.heapPtr = a; return; } // vuelve al tope
    this.freeBlocks.set(a, n); this.freeEnd.set(a + n, a); this.bins[this.binOf(n)].add(a);
  }
  removeFree(a, n) { this.freeBlocks.delete(a); this.freeEnd.delete(a + n); this.bins[this.binOf(n)].delete(a); }
  alloc(n, zero = true) {
    n = Math.max(16, (n + 15) & ~15);
    this.ensureFree();
    let a = -1;
    for (let b = this.binOf(n); b < 32 && a < 0; b++) {
      const bin = this.bins[b]; if (!bin.size) continue;
      for (const x of bin) { const sz = this.freeBlocks.get(x); if (sz >= n) { a = x; this.removeFree(x, sz); if (sz > n) this.addFree(x + n, sz - n); break; } }
    }
    if (a < 0) {
      a = this.heapPtr;
      if (a < HEAP2_BASE && a + n > HEAP_END && this.size >= HEAP2_END) { const gap = HEAP_END - a; this.heapPtr = HEAP2_BASE; if (gap >= 16) { this.freeBlocks.set(a, gap); this.freeEnd.set(a + gap, a); this.bins[this.binOf(gap)].add(a); } a = this.heapPtr; } // salto al segundo tramo (el resto queda libre)
      if (a + n > (a >= HEAP2_BASE ? HEAP2_END : HEAP_END)) throw new Error(`Heap agotado (pedido ${n} bytes; en uso ${((this.heapPtr - HEAP_BASE) / 1048576).toFixed(0)} MB, libres ${(this.freeBytes() / 1048576).toFixed(0)} MB)`);
      this.heapPtr += n;
    }
    this.blocks.set(a, n);
    if (zero) this.u8.fill(0, a, a + n);
    return a;
  }
  freeBytes() { let t = 0; for (const n of this.freeBlocks.values()) t += n; return t; }
  free(a) {
    const n = this.blocks.get(a);
    if (!n) return false;
    this.blocks.delete(a);
    this.ensureFree(); this.addFree(a, n);
    return true;
  }
  blockSize(a) { return this.blocks.get(a) ?? -1; }
  realloc(a, n) {
    if (!a) return this.alloc(n);
    const old = this.blocks.get(a);
    if (old === undefined) return 0;
    if (n <= old) return a;
    const b = this.alloc(n);
    this.copy(b, a, old);
    this.free(a);
    return b;
  }
}
