// jit.js — recompilador dinámico de bloques básicos x86 -> funciones JavaScript.
//
// Cada bloque (secuencia de instrucciones hasta un salto/call/ret) se decodifica UNA vez y se
// traduce a código JS que V8 compila a código máquina. Mejoras respecto del intérprete:
//  - sin decodificación repetida (ModRM, prefijos, inmediatos ya resueltos como constantes);
//  - direcciones efectivas como expresiones con constantes plegadas;
//  - eliminación de flags muertos: si una instrucción posterior del bloque sobrescribe los
//    flags antes de que nadie los lea, no se calculan.
// Las instrucciones sin traducción directa (x87, strings, mul/div, etc.) se ejecutan dentro del
// bloque llamando al intérprete (c.step()), así que la semántica es exactamente la ya probada.
// Código automodificable: las páginas con código compilado se marcan y una escritura en ellas
// invalida sus bloques.

const CC = ['c.of', '!c.of', 'c.cf', '!c.cf', 'c.zf', '!c.zf', '(c.cf||c.zf)', '!(c.cf||c.zf)', 'c.sf', '!c.sf', 'c.pf', '!c.pf',
  '(c.sf!==c.of)', '(c.sf===c.of)', '(c.zf||c.sf!==c.of)', '(!c.zf&&c.sf===c.of)'];
// Flags individuales: CF=1 ZF=2 SF=4 OF=8 PF=16 AF=32
const CF = 1, ZF = 2, SF = 4, OF = 8, PF = 16, AF = 32;
const F_ALL = 63, F_CF = CF, F_OSZP = ZF | SF | OF | PF | AF;
const F_LOGIC = CF | ZF | SF | OF | PF; // and/or/xor/test y shifts: AF intacto (igual que el intérprete)
const CC_READS = [OF, OF, CF, CF, ZF, ZF, CF | ZF, CF | ZF, SF, SF, PF, PF, SF | OF, SF | OF, ZF | SF | OF, ZF | SF | OF];
const MAX_BLOCK = 128;

// ---------- decodificador de longitud / campos ----------
// Tablas del mapa de opcodes de 1 byte
const HAS_MODRM = new Uint8Array(256);
for (const o of [0x62, 0x63, 0x69, 0x6b, 0xc0, 0xc1, 0xc4, 0xc5, 0xc6, 0xc7, 0xd0, 0xd1, 0xd2, 0xd3, 0xf6, 0xf7, 0xfe, 0xff]) HAS_MODRM[o] = 1;
for (let o = 0; o < 0x40; o++) if ((o & 7) < 4) HAS_MODRM[o] = 1;
for (let o = 0x80; o <= 0x8f; o++) HAS_MODRM[o] = 1;
for (let o = 0xd8; o <= 0xdf; o++) HAS_MODRM[o] = 1;
// tamaño de inmediato: 1 = imm8, 2 = imm16, 4 = imm32 (o 16 con 0x66), 'z' = según operando
function immSize(op, osz, reg) {
  if (op < 0x40 && (op & 7) === 4) return 1;
  if (op < 0x40 && (op & 7) === 5) return osz;
  switch (op) {
    case 0x6a: case 0x6b: case 0x80: case 0x82: case 0x83: case 0xa8: case 0xc0: case 0xc1: case 0xc6: case 0xcd: case 0xd4: case 0xd5:
    case 0xe4: case 0xe5: case 0xe6: case 0xe7: case 0xeb: case 0xe0: case 0xe1: case 0xe2: case 0xe3: return 1;
    case 0x68: case 0x69: case 0x81: case 0xa9: case 0xc7: return osz;
    case 0xc2: case 0xca: return 2;
    case 0xc8: return 3;
    case 0xe8: case 0xe9: return 4;
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: return 4; // moffs32
    case 0x9a: case 0xea: return 6;
    case 0xf6: return reg < 2 ? 1 : 0;
    case 0xf7: return reg < 2 ? osz : 0;
  }
  if (op >= 0x70 && op <= 0x7f) return 1;
  if (op >= 0xb0 && op <= 0xb7) return 1;
  if (op >= 0xb8 && op <= 0xbf) return osz;
  return 0;
}
function has0FModrm(op) {
  if (op >= 0x80 && op <= 0x8f) return false;
  if (op >= 0xc8 && op <= 0xcf) return false;
  return ![0x05, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0xa0, 0xa1, 0xa2, 0xa8, 0xa9, 0xaa, 0x77].includes(op);
}
function imm0F(op) { if (op >= 0x80 && op <= 0x8f) return 4; if (op === 0xa4 || op === 0xac || op === 0xba || (op >= 0x70 && op <= 0x73) || op === 0xc2 || op === 0xc4 || op === 0xc5 || op === 0xc6) return 1; return 0; }

// Decodifica una instrucción en `a`. Devuelve null si no se reconoce (se ejecutará con el intérprete).
export function decode(mem, a) {
  const start = a;
  let osz = 4, seg = 0, rep = 0, lock = 0, b;
  for (let n = 0; n < 15; n++) {
    b = mem.r8(a++);
    if (b === 0x66) osz = 2;
    else if (b === 0xf3 || b === 0xf2) rep = b;
    else if (b === 0x64) seg = 1;
    else if (b === 0x26 || b === 0x2e || b === 0x36 || b === 0x3e || b === 0x65) { /* plano */ }
    else if (b === 0xf0) lock = 1;
    else if (b === 0x67) return null;
    else break;
  }
  let op = b, two = false;
  if (op === 0x0f) { op = mem.r8(a++); two = true; }
  const ins = { start, osz, seg, rep, op, two, mod: 0, reg: 0, rm: 0, ea: null, disp: 0, imm: 0, imm2: 0, len: 0 };
  const needModrm = two ? has0FModrm(op) : HAS_MODRM[op];
  if (needModrm) {
    const m = mem.r8(a++);
    ins.mod = m >> 6; ins.reg = (m >> 3) & 7; ins.rm = m & 7;
    if (ins.mod !== 3) {
      let base = -1, index = -1, scale = 0, disp = 0;
      if (ins.rm === 4) {
        const sib = mem.r8(a++);
        scale = sib >> 6; index = (sib >> 3) & 7; base = sib & 7;
        if (index === 4) index = -1;
        if (base === 5 && ins.mod === 0) { base = -1; disp = mem.r32(a) | 0; a += 4; }
      } else if (ins.rm === 5 && ins.mod === 0) { disp = mem.r32(a) | 0; a += 4; }
      else base = ins.rm;
      if (ins.mod === 1) { disp = (mem.r8(a) << 24) >> 24; a += 1; }
      else if (ins.mod === 2) { disp = mem.r32(a) | 0; a += 4; }
      ins.ea = { base, index, scale, disp };
    }
  }
  const isz = two ? imm0F(op) : immSize(op, osz, ins.reg);
  if (isz === 1) ins.imm = mem.r8(a);
  else if (isz === 2) ins.imm = mem.r16(a);
  else if (isz === 3) { ins.imm = mem.r16(a); ins.imm2 = mem.r8(a + 2); }
  else if (isz === 4 || isz === 6) ins.imm = mem.r32(a);
  a += isz;
  ins.len = a - start;
  return ins;
}

// ---------- generación de código ----------
function eaExpr(ins) {
  const { base, index, scale, disp } = ins.ea;
  const parts = [];
  if (base >= 0) parts.push(`r[${base}]`);
  if (index >= 0) parts.push(scale ? `(r[${index}]<<${scale})` : `r[${index}]`);
  if (disp) parts.push(String(disp));
  if (ins.seg) parts.push('c.fsBase');
  if (!parts.length) return '0';
  return `((${parts.join('+')})>>>0)`;
}
const RD = { 1: 'm.r8', 2: 'm.r16', 4: 'm.r32' };
const WR = { 1: 'm.w8', 2: 'm.w16', 4: 'm.w32' };
const MASKS = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
function regRead(sz, i) {
  if (sz === 4) return `r[${i}]`;
  if (sz === 2) return `(r[${i}]&0xffff)`;
  return i < 4 ? `(r[${i}]&0xff)` : `((r[${i - 4}]>>>8)&0xff)`;
}
function regWrite(sz, i, v) {
  if (sz === 4) return `r[${i}]=${v};`;
  if (sz === 2) return `r[${i}]=(r[${i}]&0xffff0000)|((${v})&0xffff);`;
  return i < 4 ? `r[${i}]=(r[${i}]&0xffffff00)|((${v})&0xff);` : `r[${i - 4}]=(r[${i - 4}]&0xffff00ff)|(((${v})&0xff)<<8);`;
}
function wrap(sz, expr) { return sz === 4 ? `((${expr})>>>0)` : `((${expr})&${MASKS[sz]})`; }

// Información de flags por instrucción: { reads, writes } (máscaras F_CF / F_OSZP)
function flagInfo(ins) {
  const { op, two, reg } = ins;
  if (!two) {
    if (op < 0x40 && (op & 7) < 6) { const a = op >> 3; return a === 2 || a === 3 ? { reads: CF, writes: F_ALL & ~AF } : a === 1 || a === 4 || a === 6 ? { reads: 0, writes: F_LOGIC } : { reads: 0, writes: F_ALL }; }
    if (op >= 0x40 && op <= 0x4f) return { reads: 0, writes: F_OSZP };
    if (op === 0x80 || op === 0x81 || op === 0x83) return reg === 2 || reg === 3 ? { reads: CF, writes: F_ALL & ~AF } : reg === 1 || reg === 4 || reg === 6 ? { reads: 0, writes: F_LOGIC } : { reads: 0, writes: F_ALL };
    if (op === 0x84 || op === 0x85 || op === 0xa8 || op === 0xa9) return { reads: 0, writes: F_LOGIC };
    if (op >= 0x70 && op <= 0x7f) return { reads: CC_READS[op & 15], writes: 0 };
    if (op === 0xc1 || op === 0xd1 || op === 0xc0 || op === 0xd0) {
      const cnt = op === 0xd1 || op === 0xd0 ? 1 : ins.imm & 31;
      if (!cnt) return { reads: 0, writes: 0 };
      if (reg === 2 || reg === 3) return { reads: CF, writes: CF | OF };
      if (reg <= 1) return { reads: 0, writes: CF | OF };
      return { reads: 0, writes: F_LOGIC };
    }
    if (op === 0xd3) return { reads: F_ALL, writes: 0 }; // count puede ser 0 -> flags intactos
    if (op === 0x69 || op === 0x6b) return { reads: 0, writes: CF | OF };
    if (op === 0xf7 && reg === 3) return { reads: 0, writes: F_ALL };
    if ((op === 0xf6 || op === 0xf7) && reg <= 1) return { reads: 0, writes: F_LOGIC };
    if (op === 0x9b) return { reads: 0, writes: 0 };
    if (op === 0xda || op === 0xdb) return { reads: F_ALL, writes: F_ALL & 0 }; // fcmov lee flags; fcomi los escribe
    if (op >= 0xd8 && op <= 0xdf) return { reads: 0, writes: 0 };
    if (op === 0xf7 && reg === 2) return { reads: 0, writes: 0 };
    if ((op === 0xfe || op === 0xff) && reg <= 1) return { reads: 0, writes: F_OSZP };
    if ([0x88, 0x89, 0x8a, 0x8b, 0x8d, 0xc6, 0xc7, 0x68, 0x6a, 0x99, 0x98, 0x90, 0xc9, 0xa1, 0xa3, 0xa0, 0xa2, 0xe8, 0xe9, 0xeb, 0xc3, 0xc2].includes(op)) return { reads: 0, writes: 0 };
    if (op >= 0x50 && op <= 0x5f) return { reads: 0, writes: 0 };
    if (op >= 0xb0 && op <= 0xbf) return { reads: 0, writes: 0 };
    if (op === 0xff && (reg === 2 || reg === 4 || reg === 6)) return { reads: 0, writes: 0 };
  } else {
    if (op >= 0x80 && op <= 0x8f) return { reads: CC_READS[op & 15], writes: 0 };
    if (op >= 0x90 && op <= 0x9f) return { reads: CC_READS[op & 15], writes: 0 };
    if (op >= 0x40 && op <= 0x4f) return { reads: CC_READS[op & 15], writes: 0 };
    if (op === 0xb6 || op === 0xb7 || op === 0xbe || op === 0xbf) return { reads: 0, writes: 0 };
    if (op === 0xaf) return { reads: 0, writes: CF | OF };
  }
  return { reads: F_ALL, writes: 0 }; // instrucción ejecutada por el intérprete: conservador
}

// Traduce una instrucción. Devuelve { code, end } o null (=> se usa el intérprete).
// `need` = flags que esta instrucción debe dejar calculados (los demás están muertos).
function translate(ins, need) {
  const { op, two, osz, mod, reg, rm, rep } = ins;
  const next = (ins.start + ins.len) >>> 0;
  if (rep) return null;
  const W = osz; // tamaño de operando "completo": 4, o 2 con prefijo 0x66
  const only32 = () => osz !== 4;
  const ea = ins.ea ? eaExpr(ins) : null;
  const isMem = mod !== 3;
  const rd = (sz) => (isMem ? `${RD[sz]}(a)` : regRead(sz, rm));
  const wrRM = (sz, v) => (isMem ? `${WR[sz]}(a,${v});` : regWrite(sz, rm, v));
  const pre = isMem ? `const a=${ea};` : '';
  if (!two) {
    // ---- ALU 00-3F ----
    if (op < 0x40 && (op & 7) < 6) {
      const aop = op >> 3, form = op & 7;
      const sz = form & 1 ? W : 1;
      let A, B, store;
      if (form === 0 || form === 1) { A = rd(sz); B = regRead(sz, reg); store = (v) => wrRM(sz, v); }
      else if (form === 2 || form === 3) { A = regRead(sz, reg); B = rd(sz); store = (v) => regWrite(sz, reg, v); }
      else { A = regRead(sz, 0); B = String(form === 4 ? ins.imm : ins.imm >>> 0); store = (v) => regWrite(sz, 0, v); }
      return { code: `{${pre}${aluCode(aop, A, B, sz, need, store)}}` };
    }
    if (op === 0x80 || op === 0x81 || op === 0x83) {
      const sz = op === 0x80 ? 1 : W;
      const imm = op === 0x83 ? (((ins.imm << 24) >> 24) >>> 0) & MASKS[sz] : ins.imm >>> 0;
      return { code: `{${pre}${aluCode(reg, rd(sz), String(imm >>> 0), sz, need, (v) => wrRM(sz, v))}}` };
    }
    if (op === 0x84 || op === 0x85) { const sz = op === 0x84 ? 1 : W; return { code: `{${pre}${aluCode(4, rd(sz), regRead(sz, reg), sz, need, null)}}` }; }
    if (op === 0xa8) return { code: `{${aluCode(4, 'c.getReg(1,0)', String(ins.imm), 1, need, null)}}` };
    if (op === 0xa9) return { code: `{${aluCode(4, regRead(W, 0), String(ins.imm >>> 0), W, need, null)}}` };
    if (op === 0xf6 && reg <= 1) return { code: `{${pre}${aluCode(4, rd(1), String(ins.imm), 1, need, null)}}` };
    if (op === 0xf7 && reg <= 1) return { code: `{${pre}${aluCode(4, rd(W), String(ins.imm >>> 0), W, need, null)}}` };
    if (op === 0x9b) return { code: '' }; // fwait
    if (op >= 0xd8 && op <= 0xdf) {
      const fast = fpuFast(op, mod, reg, rm);
      if (fast) return { code: `{${isMem ? `const a=${ea};` : ''}const f=c.fpu;${fast}}` };
      return { code: `{${isMem ? `const a=${ea};` : ''}c.instrStart=${ins.start};c.fpu.exec(${op},${mod},${reg},${rm},${isMem ? 'a' : -1});}` };
    }
    if (op >= 0x40 && op <= 0x47) return { code: incdec(0, regRead(W, op & 7), W, need, (v) => regWrite(W, op & 7, v)) };
    if (op >= 0x48 && op <= 0x4f) return { code: incdec(5, regRead(W, op & 7), W, need, (v) => regWrite(W, op & 7, v)) };
    if ((op === 0xfe || op === 0xff) && reg <= 1) { const sz = op === 0xfe ? 1 : W; return { code: `{${pre}${incdec(reg === 0 ? 0 : 5, rd(sz), sz, need, (v) => wrRM(sz, v))}}` }; }
    // ---- MOV ----
    if (op === 0x88) return { code: `{${pre}${wrRM(1, regRead(1, reg))}}` };
    if (op === 0x89) return { code: `{${pre}${wrRM(W, regRead(W, reg))}}` };
    if (op === 0x8a) return { code: `{${pre}${regWrite(1, reg, rd(1))}}` };
    if (op === 0x8b) return { code: `{${pre}${regWrite(W, reg, rd(W))}}` };
    if (op === 0xc6) return { code: `{${pre}${wrRM(1, String(ins.imm))}}` };
    if (op === 0xc7) return { code: `{${pre}${wrRM(W, String(ins.imm >>> 0))}}` };
    if (op >= 0xb0 && op <= 0xb7) return { code: regWrite(1, op & 7, String(ins.imm)) };
    if (op >= 0xb8 && op <= 0xbf) return { code: regWrite(W, op & 7, String(ins.imm >>> 0)) };
    if (op === 0xa1) return { code: regWrite(W, 0, `${RD[W]}(${ins.seg ? `(${ins.imm}+c.fsBase)>>>0` : ins.imm >>> 0})`) };
    if (op === 0xa3) return { code: `${WR[W]}(${ins.seg ? `(${ins.imm}+c.fsBase)>>>0` : ins.imm >>> 0},r[0]);` };
    if (op === 0xa0) return { code: `c.setReg(1,0,m.r8(${ins.seg ? `(${ins.imm}+c.fsBase)>>>0` : ins.imm >>> 0}));` };
    if (op === 0xa2) return { code: `m.w8(${ins.seg ? `(${ins.imm}+c.fsBase)>>>0` : ins.imm >>> 0},r[0]);` };
    if (op === 0x8d && isMem) { const e = { ...ins, seg: 0 }; return { code: `r[${reg}]=${eaExpr(e)};` }; }
    // ---- pila ----
    if (osz !== 4 && ((op >= 0x50 && op <= 0x5f) || op === 0x68 || op === 0x6a || op === 0x8d || op === 0x98 || op === 0x99 || op === 0xc9 || (op === 0xff && reg >= 2) || op === 0x69 || op === 0x6b || (op === 0xf7 && reg >= 2))) return null;
    if (op >= 0x50 && op <= 0x57) return { code: `{const v=r[${op & 7}];r[4]=r[4]-4;m.w32(r[4],v);}` };
    if (op >= 0x58 && op <= 0x5f) return { code: `{const v=m.r32(r[4]);r[4]=r[4]+4;r[${op & 7}]=v;}` };
    if (op === 0x68) return { code: `r[4]=r[4]-4;m.w32(r[4],${ins.imm >>> 0});` };
    if (op === 0x6a) return { code: `r[4]=r[4]-4;m.w32(r[4],${((ins.imm << 24) >> 24) >>> 0});` };
    if (op === 0xff && reg === 6) return { code: `{${pre}const v=${rd(4)};r[4]=r[4]-4;m.w32(r[4],v);}` };
    if (op === 0xc9) return { code: `r[4]=r[5];r[5]=m.r32(r[4]);r[4]=r[4]+4;` };
    // ---- varios ----
    if (op === 0x90) return { code: '' };
    if (op === 0x99) return { code: `r[2]=(r[0]&0x80000000)?0xffffffff:0;` };
    if (op === 0x98) return { code: `r[0]=(r[0]<<16)>>16;` };
    if (op === 0xf7 && reg === 2) return { code: `{${pre}${wrRM(4, `(~${rd(4)})>>>0`)}}` };
    if (op === 0xf7 && reg === 3) {
      return { code: `{${pre}const v=${rd(4)};` + (need ? `const x=c.alu(5,0,v,4);c.cf=v!==0?1:0;${wrRM(4, 'x')}}` : `${wrRM(4, '(-v)>>>0')}}`) };
    }
    if (op === 0xc0 || op === 0xc1 || op === 0xd0 || op === 0xd1 || op === 0xd3) {
      const sz = op === 0xc0 || op === 0xd0 ? 1 : W;
      const cnt = op === 0xd3 ? 'r[1]&255' : String(op === 0xd1 || op === 0xd0 ? 1 : ins.imm & 31);
      if (!need && sz === 4 && op !== 0xd3 && (reg === 4 || reg === 5 || reg === 7 || reg === 6)) {
        const k = op === 0xd1 ? 1 : ins.imm & 31;
        if (!k) return { code: '' };
        const e = reg === 5 ? `v>>>${k}` : reg === 7 ? `(v>>${k})>>>0` : `(v<<${k})>>>0`;
        return { code: `{${pre}const v=${rd(4)};${wrRM(4, e)}}` };
      }
      if (op !== 0xd3 && sz >= 2 && (reg === 4 || reg === 5 || reg === 6 || reg === 7)) {
        const k = op === 0xd1 ? 1 : ins.imm & 31;
        if (!k) return { code: '' };
        if (k <= sz * 8) return { code: `{${pre}${shiftCode(reg, rd(sz), k, sz, need, (v) => wrRM(sz, v))}}` };
      }
      return { code: `{${pre}${wrRM(sz, `c.shift(${reg},${rd(sz)},${cnt},${sz})`)}}` };
    }
    if (op === 0x69 || op === 0x6b) {
      const b = op === 0x6b ? (ins.imm << 24) >> 24 : ins.imm | 0;
      if (!need) return { code: `{${pre}r[${reg}]=Math.imul(${rd(4)}|0,${b});}` };
      return { code: `{${pre}c.imulSet(${rd(4)}|0,${b},4,${reg});}` };
    }
    // ---- control de flujo (cierran el bloque) ----
    if (op >= 0x70 && op <= 0x7f) { const t = (next + ((ins.imm << 24) >> 24)) >>> 0; return { code: `c.eip=${CC[op & 15]}?${t}:${next};`, end: true }; }
    if (op === 0xeb) return { code: `c.eip=${(next + ((ins.imm << 24) >> 24)) >>> 0};`, end: true };
    if (op === 0xe9) return { code: `c.eip=${(next + (ins.imm | 0)) >>> 0};`, end: true };
    if (op === 0xe8) return { code: `r[4]=r[4]-4;m.w32(r[4],${next});c.eip=${(next + (ins.imm | 0)) >>> 0};`, end: true };
    if (op === 0xc3) return { code: `c.eip=m.r32(r[4]);r[4]=r[4]+4;`, end: true };
    if (op === 0xc2) return { code: `c.eip=m.r32(r[4]);r[4]=r[4]+${4 + ins.imm};`, end: true };
    if (op === 0xff && reg === 2) return { code: `{${pre}const t=${rd(4)};r[4]=r[4]-4;m.w32(r[4],${next});c.eip=t;}`, end: true };
    if (op === 0xff && reg === 4) return { code: `{${pre}c.eip=${rd(4)};}`, end: true };
    return null;
  }
  // ---- 0F xx ----
  if (osz === 4) { const mm = mmxCode(ins, isMem, pre); if (mm) return { code: mm }; }
  if (osz !== 4 && !((op >= 0x90 && op <= 0x9f) || op === 0xb6 || op === 0xbe)) return null;
  if (op >= 0x80 && op <= 0x8f) { const t = (next + (ins.imm | 0)) >>> 0; return { code: `c.eip=${CC[op & 15]}?${t}:${next};`, end: true }; }
  if (op >= 0x90 && op <= 0x9f) return { code: `{${pre}${wrRM(1, `${CC[op & 15]}?1:0`)}}` };
  if (op >= 0x40 && op <= 0x4f) return { code: `{${pre}const v=${rd(4)};if(${CC[op & 15]})r[${reg}]=v;}` };
  if (op === 0xb6) return { code: `{${pre}${regWrite(W, reg, rd(1))}}` };
  if (op === 0xb7) return { code: `{${pre}r[${reg}]=${rd(2)};}` };
  if (op === 0xbe) return { code: `{${pre}${regWrite(W, reg, `((${rd(1)}<<24)>>24)&${MASKS[W]}`)}}` };
  if (op === 0xbf) return { code: `{${pre}r[${reg}]=(${rd(2)}<<16)>>16;}` };
  if (op === 0xaf) {
    if (!need) return { code: `{${pre}r[${reg}]=Math.imul(r[${reg}]|0,${rd(4)}|0);}` };
    return { code: `{${pre}c.imulSet(r[${reg}]|0,${rd(4)}|0,4,${reg});}` };
  }
  return null;
}

// Calcula sólo los flags pedidos en `need`, con la misma semántica que CPU.alu
// x87 frecuente en el render y la física; misma semántica que fpu.js (exec)
function fpuFast(op, mod, reg, rm) {
  const ARITH = { 0: 'v0+v', 1: 'v0*v', 4: 'v0-v', 5: 'v-v0', 6: 'v0/v', 7: 'v/v0' };
  const CMP = (B) => `{const x=f.get(0),y=${B};if(x!==x||y!==y){f.c0=1;f.c2=1;f.c3=1;}else{f.c2=0;f.c0=x<y?1:0;f.c3=x===y?1:0;}}`;
  if (mod !== 3) {
    if ((op === 0xd8 || op === 0xdc) && (reg === 2 || reg === 3)) return CMP(op === 0xd8 ? 'm.f32(a)' : 'm.f64(a)') + (reg === 3 ? 'f.pop();' : '');
    if ((op === 0xd8 || op === 0xdc) && ARITH[reg]) return `const v=${op === 0xd8 ? 'm.f32(a)' : 'm.f64(a)'},v0=f.get(0);f.set(0,${ARITH[reg]});`;
    if (op === 0xda && ARITH[reg]) return `const v=m.r32(a)|0,v0=f.get(0);f.set(0,${ARITH[reg]});`;
    if (op === 0xd9 && reg === 0) return 'f.push(m.f32(a));';
    if (op === 0xd9 && reg === 2) return 'm.wf32(a,f.get(0));';
    if (op === 0xd9 && reg === 3) return 'm.wf32(a,f.pop());';
    if (op === 0xd9 && reg === 5) return 'f.cw=m.r16(a);';
    if (op === 0xd9 && reg === 7) return 'm.w16(a,f.cw);';
    if (op === 0xdd && reg === 0) return 'f.push(m.f64(a));';
    if (op === 0xdd && reg === 2) return 'm.wf64(a,f.get(0));';
    if (op === 0xdd && reg === 3) return 'm.wf64(a,f.pop());';
    if (op === 0xdb && reg === 0) return 'f.push(m.r32(a)|0);';
    if (op === 0xdb && reg === 2) return 'm.w32(a,f.toInt(f.get(0),32)>>>0);';
    if (op === 0xdb && reg === 3) return 'm.w32(a,f.toInt(f.pop(),32)>>>0);';
    if (op === 0xdf && reg === 0) return 'f.push((m.r16(a)<<16)>>16);';
    if (op === 0xdf && reg === 3) return 'm.w16(a,f.toInt(f.pop(),16)&0xffff);';
    return null;
  }
  if (op === 0xd8 && (reg === 2 || reg === 3)) return CMP(`f.get(${rm})`) + (reg === 3 ? 'f.pop();' : '');
  if (op === 0xde && reg === 3 && rm === 1) return CMP('f.get(1)') + 'f.pop();f.pop();';
  if (op === 0xdf && reg === 4 && rm === 0) return 'r[0]=(r[0]&0xffff0000)|(((f.sw&0x3fff&~0x4700)|(f.c0<<8)|(f.c1<<9)|(f.c2<<10)|(c.fpu.top<<11)|(f.c3<<14))&0xffff);';
  if (op === 0xd8 && ARITH[reg]) return `const v=f.get(${rm}),v0=f.get(0);f.set(0,${ARITH[reg]});`;
  if (op === 0xd9 && reg === 0) return `f.push(f.get(${rm}));`;
  if (op === 0xd9 && reg === 1) return `const t=f.get(0);f.set(0,f.get(${rm}));f.set(${rm},t);`;
  if (op === 0xd9 && reg === 4 && rm === 0) return 'f.set(0,-f.get(0));';
  if (op === 0xd9 && reg === 4 && rm === 1) return 'f.set(0,Math.abs(f.get(0)));';
  if (op === 0xd9 && reg === 5 && rm === 0) return 'f.push(1);';
  if (op === 0xd9 && reg === 5 && rm === 6) return 'f.push(0);';
  if (op === 0xd9 && reg === 7 && rm === 2) return 'f.set(0,Math.sqrt(f.get(0)));';
  // DC/DE con registro: destino st(i), sub/div invertidos (igual que fpu.js)
  const RARITH = { 0: 'a+b', 1: 'a*b', 4: 'b-a', 5: 'a-b', 6: 'b/a', 7: 'a/b' };
  if ((op === 0xdc || op === 0xde) && RARITH[reg]) return `const a=f.get(${rm}),b=f.get(0);f.set(${rm},${RARITH[reg]});${op === 0xde ? 'f.pop();' : ''}`;
  if (op === 0xdd && reg === 2) return `f.set(${rm},f.get(0));`;
  if (op === 0xdd && reg === 3) return `f.set(${rm},f.get(0));f.pop();`;
  return null;
}

function aluCode(aop, A, B, sz, need, store) {
  if (need || aop === 2 || aop === 3) {
    const bits = sz * 8, sh = bits - 1;
    let v, f = '';
    switch (aop) {
      case 0: v = sz === 4 ? '(s>>>0)' : `(s&${MASKS[sz]})`; break;
      case 2: v = sz === 4 ? '(s>>>0)' : `(s&${MASKS[sz]})`; break;
      case 3: v = sz === 4 ? '((x-y-k)>>>0)' : `((x-y-k)&${MASKS[sz]})`; break;
      case 5: case 7: v = sz === 4 ? '((x-y)>>>0)' : `((x-y)&${MASKS[sz]})`; break;
      case 1: v = '(x|y)>>>0'; break; case 4: v = '(x&y)>>>0'; break; case 6: v = '(x^y)>>>0'; break;
    }
    let code = `const x=${A},y=${B};`;
    if (aop === 0) code += 'const s=x+y;';
    if (aop === 2) code += 'const s=x+y+c.cf;';
    if (aop === 3) code += 'const k=c.cf;';
    code += `const v=${v};`;
    const ofExpr = (e) => (sz === 4 ? `((${e})>>>31)` : `(((${e})>>${sh})&1)`);
    if (aop === 0 || aop === 2) {
      if (need & CF) f += `c.cf=s>${MASKS[sz]}?1:0;`;
      if (need & OF) f += `c.of=${ofExpr('(x^v)&(y^v)')};`;
      if (aop === 0 && need & AF) f += 'c.af=((x^y^v)>>4)&1;';
    } else if (aop === 5 || aop === 7 || aop === 3) {
      if (need & CF) f += aop === 3 ? 'c.cf=x<y+k?1:0;' : 'c.cf=x<y?1:0;';
      if (need & OF) f += `c.of=${ofExpr('(x^y)&(x^v)')};`;
      if (aop !== 3 && need & AF) f += 'c.af=((x^y^v)>>4)&1;';
    } else {
      if (need & CF) f += 'c.cf=0;';
      if (need & OF) f += 'c.of=0;';
    }
    if (need & ZF) f += 'c.zf=v===0?1:0;';
    if (need & SF) f += `c.sf=(v>>>${sh})&1;`;
    if (need & PF) f += 'c.pf=c.parity[v&255];';
    // adc/sbb: el intérprete calcula siempre todos (salvo AF); los marcamos como "need" completo en flagInfo
    return `{${code}${f}${aop === 7 || !store ? '' : store('v')}}`;
  }
  if (aop === 7 || !store) return ''; // cmp/test con flags muertos: no hace nada
  let e;
  switch (aop) {
    case 0: e = wrap(sz, `${A}+${B}`); break;
    case 1: e = wrap(sz, `${A}|${B}`); break;
    case 4: e = wrap(sz, `${A}&${B}`); break;
    case 5: e = wrap(sz, `${A}-${B}`); break;
    case 6: e = wrap(sz, `${A}^${B}`); break;
  }
  return store(e);
}
// shl/shr/sar con cuenta constante k (1..bits); flags idénticos a CPU.shift
function shiftCode(reg, A, k, sz, need, store) {
  const bits = sz * 8, M = MASKS[sz], sh = bits - 1;
  let c = `const x=${A};`, v;
  if (reg === 4 || reg === 6) { v = k >= 32 ? '0' : sz === 4 ? `((x<<${k})>>>0)` : `((x<<${k})&${M})`; c += `const v=${v};`; if (need & (CF | OF)) c += `const cf=(x>>>${bits - k})&1;c.cf=cf;`; if (need & OF) c += `c.of=((v>>>${sh})&1)^cf;`; }
  else if (reg === 5) { c += `const v=x>>>${k};`; if (need & CF) c += `c.cf=(x>>>${k - 1})&1;`; if (need & OF) c += `c.of=(x>>>${sh})&1;`; }
  else { const sx = sz === 4 ? 'x|0' : `(x<<16)>>16`; c += `const sv=${sx};const v=((sv>>${k})&${M})>>>0;`; if (need & CF) c += `c.cf=(sv>>${k - 1})&1;`; if (need & OF) c += 'c.of=0;'; }
  if (need & ZF) c += 'c.zf=v===0?1:0;';
  if (need & SF) c += `c.sf=(v>>>${sh})&1;`;
  if (need & PF) c += 'c.pf=c.parity[v&255];';
  return c + store('v');
}

function incdec(aop, A, sz, need, store) {
  if (!need) return store(wrap(sz, aop === 0 ? `${A}+1` : `${A}-1`));
  // inc/dec = add/sub 1 sin tocar CF
  return aluCode(aop, A, '1', sz, need & ~CF, store);
}

// ---------- compilación de un bloque ----------
// Decodifica y traduce el bloque básico que empieza en `eip`. Devuelve el cuerpo JS y los sucesores estáticos.
function blockDecode(emu, eip) {
  const mem = emu.mem;
  const list = [];
  let a = eip;
  for (let n = 0; n < MAX_BLOCK; n++) {
    if (a >= 0x00100000 && a < 0x00110000) break; // zona de thunks
    let ins;
    try { ins = decode(mem, a); } catch { ins = null; }
    if (!ins) { list.push({ start: a, fallback: true, len: 0, end: true }); break; }
    const ctl = isControl(ins);
    list.push(ins);
    a = (a + ins.len) >>> 0;
    if (ctl) break;
  }
  // sucesores estáticos (para regiones) y si el bloque puede salir de forma dinámica
  const last = list[list.length - 1]; let succ = [], dyn = false;
  if (!last || last.fallback) dyn = true;
  else if (isControl(last)) { succ = staticSucc(last); if (!succ.length) dyn = true; }
  else succ = [a];
  // flags que el bloque lee antes de escribir (dado lo que necesitan sus sucesores)
  return { list, next: a, succ, dyn };
}
function liveIn(dec, liveOut) {
  let live = liveOut;
  for (let i = dec.list.length - 1; i >= 0; i--) { const ins = dec.list[i]; const fi = ins.fallback ? { reads: F_ALL, writes: 0 } : flagInfo(ins); live = (live & ~fi.writes) | fi.reads; }
  return live;
}
function blockSource(emu, eip, dec = blockDecode(emu, eip), liveOut = F_ALL) {
  const { list, next: a } = dec;
  // liveness de flags hacia atrás
  let live = liveOut;
  for (let i = list.length - 1; i >= 0; i--) {
    const ins = list[i];
    const fi = ins.fallback ? { reads: F_ALL, writes: 0 } : flagInfo(ins);
    ins.need = live & fi.writes;
    live = (live & ~fi.writes) | fi.reads;
  }
  let body = '';
  let compiled = 0, fallbacks = 0, ended = false, succ = [];
  const pages = new Set([eip >>> 12]);
  for (const ins of list) {
    pages.add(ins.start >>> 12); if (ins.len) pages.add((ins.start + ins.len - 1) >>> 12);
    if (ins.fallback) { body += `c.eip=${ins.start};c.step();return;`; fallbacks++; ended = true; break; }
    const t = translate(ins, ins.need);
    if (t) {
      body += t.code;
      compiled++;
      if (t.end) { ended = true; succ = staticSucc(ins); break; }
    } else {
      // intérprete para esta instrucción; si podía saltar, termina el bloque
      body += `c.eip=${ins.start};c.step();`;
      fallbacks++;
      if (isControl(ins)) { body += 'return;'; ended = true; break; }
    }
  }
  if (!ended) { body += `c.eip=${a};`; succ = [a]; }
  return { list, body, pages, compiled, fallbacks, ended, succ };
}
function staticSucc(ins) {
  const next = (ins.start + ins.len) >>> 0;
  if (isCondJump(ins)) return ins.op === 0xeb || ins.op === 0xe9 ? [jumpTarget(ins)] : [jumpTarget(ins), next];
  if (!ins.two && ins.op === 0xe8) return [(next + (ins.imm | 0)) >>> 0, next];
  return [];
}

export function compileBlock(emu, eip) {
  const { list, body, pages, compiled, fallbacks, ended } = blockSource(emu, eip);
  let src;
  const last = list[list.length - 1];
  const selfLoop = ended && fallbacks === 0 && last && !last.fallback && isCondJump(last) && jumpTarget(last) === eip;
  if (selfLoop) {
    // bucle cerrado: se itera dentro de la función (hasta 4096 vueltas, para poder ceder el control)
    src = `c.instrStart=${eip};for(let it=0;it<4096;it++){c.icount+=${compiled};${body}if(c.eip!==${eip})return;}`;
  } else src = `c.icount+=${compiled};c.instrStart=${eip};${body}`;
  return finish(emu, eip, src, pages, list.length, compiled, fallbacks);
}

// Región: varios bloques alcanzables por saltos estáticos (jcc, jmp, call y su retorno) compilados en UNA
// función con un switch sobre EIP. Los saltos internos y los `ret` que vuelven dentro de la región no pasan
// por el despachador. Cualquier EIP fuera de la región (API, hook, código no incluido) devuelve el control.
const REGION_BLOCKS = 40, REGION_INSTRS = 900;
export function compileRegion(emu, entry) {
  const decs = new Map(); const queue = [entry]; let instrs = 0;
  const hooks = emu.hooks;
  if (hooks && hooks.has(entry)) return compileBlock(emu, entry);
  while (queue.length && decs.size < REGION_BLOCKS && instrs < REGION_INSTRS) {
    const e = queue.shift() >>> 0;
    if (decs.has(e) || (e >= 0x00100000 && e < 0x00110000) || e < 0x1000) continue;
    if (e !== entry && hooks && hooks.has(e)) continue;
    let d; try { d = blockDecode(emu, e); } catch { continue; }
    if (!d.list.length) continue;
    decs.set(e, d); instrs += d.list.length;
    for (const t of d.succ) if (!decs.has(t)) queue.push(t);
  }
  if (decs.size <= 1) return compileBlock(emu, entry);
  // liveness de flags entre bloques de la región (punto fijo); salidas a código de fuera: todos vivos
  const lin = new Map(); for (const e of decs.keys()) lin.set(e, 0);
  const outOf = (d) => { if (d.dyn) return F_ALL; let o = 0; for (const t of d.succ) o |= decs.has(t) ? lin.get(t) : F_ALL; return o; };
  for (let changed = true, guard = 0; changed && guard < 100; guard++) { changed = false;
    for (const [e, d] of decs) { const v = liveIn(d, outOf(d)); if (v !== lin.get(e)) { lin.set(e, v); changed = true; } } }
  const pages = new Set(); let compiled = 0, fallbacks = 0, n = 0;
  let cases = '';
  for (const [e, d] of decs) {
    const b = blockSource(emu, e, d, emu.regionFlags === false ? F_ALL : outOf(d));
    for (const p of b.pages) pages.add(p); compiled += b.compiled; fallbacks += b.fallbacks; n += b.list.length;
    cases += `case ${e}:{c.icount+=${b.compiled};c.instrStart=${e};${b.body}}continue;`;
  }
  const src = `const self=c.jitSelf;for(let it=0;it<2048;it++){if(self.dead||c.icount>=c.stopAt)return;switch(c.eip){${cases}default:return;}}`;
  return finish(emu, entry, src, pages, n, compiled, fallbacks, true);
}

function finish(emu, eip, src, pages, n, compiled, fallbacks, region = false) {
  if (!emu.noInline) src = inlineOps(src);
  if (emu.cacheRegs !== false) src = cacheRegs(src);
  if (emu.jitNames) src += `\n//# sourceURL=${region ? 'reg' : 'blk'}_${eip.toString(16)}.js`;
  let fn;
  try {
    if (region) { const inner = new Function('c', 'r', 'm', src); fn = (c, r, m) => { c.jitSelf = fn; inner(c, r, m); }; }
    else fn = new Function('c', 'r', 'm', src);
  } catch (e) { throw new Error(`JIT: error compilando ${region ? 'región' : 'bloque'} ${eip.toString(16)}: ${e.message}\n${src.slice(0, 2000)}`); }
  fn.pages = pages; fn.n = n; fn.compiled = compiled; fn.fallbacks = fallbacks; fn.dead = false;
  return fn;
}

function isCondJump(ins) { return ins.two ? ins.op >= 0x80 && ins.op <= 0x8f : (ins.op >= 0x70 && ins.op <= 0x7f) || ins.op === 0xeb || ins.op === 0xe9; }
function jumpTarget(ins) {
  const next = (ins.start + ins.len) >>> 0;
  if (ins.two || ins.op === 0xe9) return (next + (ins.imm | 0)) >>> 0;
  return (next + ((ins.imm << 24) >> 24)) >>> 0;
}
function isControl(ins) {
  const { op, two, reg } = ins;
  if (two) return op >= 0x80 && op <= 0x8f;
  if (op >= 0x70 && op <= 0x7f) return true;
  if ([0xe8, 0xe9, 0xeb, 0xc3, 0xc2, 0xca, 0xcb, 0xcc, 0xcd, 0xcf, 0xe0, 0xe1, 0xe2, 0xe3, 0x9a, 0xea, 0xf4].includes(op)) return true;
  if (op === 0xff && (reg >= 2 && reg <= 5)) return true;
  return false;
}

// ---------- caché de bloques ----------
export class BlockCache {
  constructor(emu) {
    this.emu = emu;
    this.map = new Map();
    // tabla directa para el rango 0x400000..0x600000 (el EXE): evita el hash del Map en cada salto
    this.fastBase = 0x400000; this.fast = new Array(0x200000);
    this.byPage = new Map();
    this.stats = { compiled: 0, invalidated: 0, instrs: 0, fallbacks: 0 };
    const mem = emu.mem;
    mem.codePages = new Uint8Array(mem.size >>> 12);
    mem.onCodeWrite = (page) => this.invalidatePage(page);
  }
  get(eip) {
    let fn = this.map.get(eip);
    if (fn) return fn;
    fn = this.emu.useRegions === false ? compileBlock(this.emu, eip) : compileRegion(this.emu, eip);
    // hook de ejecución: se llama antes del bloque; si devuelve false, el bloque no se ejecuta
    // (el hook debe haber dejado c.eip en el destino que corresponda). Costo cero para bloques sin hook.
    const hook = this.emu.hooks && this.emu.hooks.get(eip);
    if (hook) { const inner = fn; fn = (c, r, m) => { if (hook(c) !== false) inner(c, r, m); }; fn.pages = inner.pages; fn.compiled = inner.compiled; fn.fallbacks = inner.fallbacks; }
    this.map.set(eip, fn);
    const fi = eip - this.fastBase; if (fi >= 0 && fi < 0x200000) this.fast[fi] = fn;
    this.stats.compiled++; this.stats.instrs += fn.compiled; this.stats.fallbacks += fn.fallbacks;
    for (const p of fn.pages) {
      this.emu.mem.codePages[p] = 1;
      let s = this.byPage.get(p); if (!s) this.byPage.set(p, (s = new Set())); s.add(eip);
    }
    return fn;
  }
  invalidatePage(page) {
    const s = this.byPage.get(page);
    this.emu.mem.codePages[page] = 0;
    if (!s) return;
    for (const e of s) { const old = this.map.get(e); if (old) old.dead = true; this.map.delete(e); const fi = e - this.fastBase; if (fi >= 0 && fi < 0x200000) this.fast[fi] = undefined; this.stats.invalidated++; }
    this.byPage.delete(page);
  }
  forget(eip) { this.map.delete(eip); const fi = eip - this.fastBase; if (fi >= 0 && fi < 0x200000) this.fast[fi] = undefined; }
  clear() { for (const p of [...this.byPage.keys()]) this.invalidatePage(p); }
}

// ---------- MMX (sin prefijo) traducido en línea; misma semántica que simd.js ----------
// D = vistas de los registros MMX (c.simd.M), S = vistas del scratch (operando de memoria).
const LANE = { 1: ['u8', 'i8', 8], 2: ['u16', 'i16', 4], 4: ['u32', 'i32', 2] };
const sat = (lo, hi) => (x) => `(${x}>${hi}?${hi}:${x}<${lo}?${lo}:${x})`;
const MMX_LANES = {
  0xfc: [1, 0, (a, b) => `${a}+${b}`], 0xfd: [2, 0, (a, b) => `${a}+${b}`], 0xfe: [4, 0, (a, b) => `${a}+${b}`],
  0xf8: [1, 0, (a, b) => `${a}-${b}`], 0xf9: [2, 0, (a, b) => `${a}-${b}`], 0xfa: [4, 0, (a, b) => `${a}-${b}`],
  0xec: [1, 1, (a, b) => sat(-128, 127)(`(${a}+${b})`)], 0xed: [2, 1, (a, b) => sat(-32768, 32767)(`(${a}+${b})`)],
  0xe8: [1, 1, (a, b) => sat(-128, 127)(`(${a}-${b})`)], 0xe9: [2, 1, (a, b) => sat(-32768, 32767)(`(${a}-${b})`)],
  0xdc: [1, 0, (a, b) => sat(0, 255)(`(${a}+${b})`)], 0xdd: [2, 0, (a, b) => sat(0, 65535)(`(${a}+${b})`)],
  0xd8: [1, 0, (a, b) => sat(0, 255)(`(${a}-${b})`)], 0xd9: [2, 0, (a, b) => sat(0, 65535)(`(${a}-${b})`)],
  0xd5: [2, 1, (a, b) => `Math.imul(${a},${b})`], 0xe5: [2, 1, (a, b) => `(${a}*${b})>>16`], 0xe4: [2, 0, (a, b) => `(${a}*${b})>>>16`],
  0xdb: [4, 0, (a, b) => `${a}&${b}`], 0xdf: [4, 0, (a, b) => `(~${a})&${b}`], 0xeb: [4, 0, (a, b) => `${a}|${b}`], 0xef: [4, 0, (a, b) => `${a}^${b}`],
  0x74: [1, 0, (a, b) => `${a}===${b}?255:0`], 0x75: [2, 0, (a, b) => `${a}===${b}?65535:0`], 0x76: [4, 0, (a, b) => `${a}===${b}?4294967295:0`],
  0x64: [1, 1, (a, b) => `${a}>${b}?-1:0`], 0x65: [2, 1, (a, b) => `${a}>${b}?-1:0`], 0x66: [4, 1, (a, b) => `${a}>${b}?-1:0`],
  0xda: [1, 0, (a, b) => `${a}<${b}?${a}:${b}`], 0xde: [1, 0, (a, b) => `${a}>${b}?${a}:${b}`], 0xea: [2, 1, (a, b) => `${a}<${b}?${a}:${b}`], 0xee: [2, 1, (a, b) => `${a}>${b}?${a}:${b}`],
  0xe0: [1, 0, (a, b) => `(${a}+${b}+1)>>1`], 0xe3: [2, 0, (a, b) => `(${a}+${b}+1)>>1`],
};
function mmxCode(ins, isMem, pre) {
  const { op, reg, rm } = ins;
  const loadS = isMem ? 'S.u32[0]=m.r32(a);S.u32[1]=m.r32(a+4);' : '';
  // fuente como (vista, índice base en lanes)
  const src = (w, signed) => { const [u, i, n] = LANE[w]; const v = signed ? i : u; return isMem ? [`S.${v}`, 0, n] : [`D.${v}`, rm * n, n]; };
  const head = `${pre}const D=c.simd.M${isMem ? ',S=c.simd.S' : ''};`;
  if (op === 0x77) return '{}'; // emms
  if (op === 0x6f) return isMem ? `{${head}D.u32[${reg * 2}]=m.r32(a);D.u32[${reg * 2 + 1}]=m.r32(a+4);}` : `{const D=c.simd.M;D.u32[${reg * 2}]=D.u32[${rm * 2}];D.u32[${reg * 2 + 1}]=D.u32[${rm * 2 + 1}];}`;
  if (op === 0x7f) return isMem ? `{${head}m.w32(a,D.u32[${reg * 2}]);m.w32(a+4,D.u32[${reg * 2 + 1}]);}` : `{const D=c.simd.M;D.u32[${rm * 2}]=D.u32[${reg * 2}];D.u32[${rm * 2 + 1}]=D.u32[${reg * 2 + 1}];}`;
  if (op === 0x6e) return `{${head}D.u32[${reg * 2}]=${isMem ? 'm.r32(a)' : `r[${rm}]`};D.u32[${reg * 2 + 1}]=0;}`;
  if (op === 0x7e) return isMem ? `{${head}m.w32(a,D.u32[${reg * 2}]);}` : `{const D=c.simd.M;r[${rm}]=D.u32[${reg * 2}];}`;
  const L = MMX_LANES[op];
  if (L) {
    const [w, signed, f] = L; const [u, i, n] = LANE[w]; const dv = `D.${signed ? i : u}`; const [sv, sb] = src(w, signed); const db = reg * n;
    let body = '';
    for (let k = 0; k < n; k++) body += `const t${k}=${f(`${dv}[${db + k}]`, `${sv}[${sb + k}]`)};`;
    for (let k = 0; k < n; k++) body += `${dv}[${db + k}]=t${k};`;
    return `{${head}${loadS}${body}}`;
  }
  if (op === 0x63 || op === 0x67 || op === 0x6b) { // packsswb / packuswb / packssdw
    const wide = op === 0x6b ? 4 : 2; const [, wi, n] = LANE[wide]; const outV = op === 0x63 ? 'i8' : op === 0x67 ? 'u8' : 'i16';
    const S8 = op === 0x63 ? sat(-128, 127) : op === 0x67 ? sat(0, 255) : sat(-32768, 32767); const [sv, sb] = src(wide, 1); const ob = reg * (8 / (wide / 2)) ;
    let body = ''; for (let k = 0; k < n; k++) body += `const a${k}=D.${wi}[${reg * n + k}],b${k}=${sv}[${sb + k}];`;
    for (let k = 0; k < n; k++) body += `D.${outV}[${ob + k}]=${S8(`a${k}`)};`;
    for (let k = 0; k < n; k++) body += `D.${outV}[${ob + n + k}]=${S8(`b${k}`)};`;
    return `{${head}${loadS}${body}}`;
  }
  if (op >= 0x60 && op <= 0x62 || op >= 0x68 && op <= 0x6a) { // punpckl / punpckh
    const w = op <= 0x62 ? 1 << (op - 0x60) : 1 << (op - 0x68); const hi = op >= 0x68; const [u, , n] = LANE[w]; const [sv, sb] = src(w, 0); const half = n / 2, off = hi ? half : 0;
    let body = ''; for (let k = 0; k < half; k++) body += `const a${k}=D.${u}[${reg * n + off + k}],b${k}=${sv}[${sb + off + k}];`;
    for (let k = 0; k < half; k++) body += `D.${u}[${reg * n + 2 * k}]=a${k};D.${u}[${reg * n + 2 * k + 1}]=b${k};`;
    return `{${head}${loadS}${body}}`;
  }
  if ((op === 0x71 || op === 0x72) && !isMem && (reg === 2 || reg === 4 || reg === 6)) { // psrl/psra/psll imm (w,d)
    const w = op === 0x71 ? 2 : 4; const [u, i, n] = LANE[w]; const bits = w * 8; const cnt = ins.imm & 255; const b = rm * n; let body = '';
    for (let k = 0; k < n; k++) {
      if (reg === 4) body += `D.${i}[${b + k}]=D.${i}[${b + k}]>>${Math.min(cnt, bits - 1)};`;
      else if (cnt >= bits) body += `D.${u}[${b + k}]=0;`;
      else body += reg === 6 ? `D.${u}[${b + k}]=D.${u}[${b + k}]<<${cnt};` : `D.${u}[${b + k}]=D.${u}[${b + k}]>>>${cnt};`;
    }
    return `{const D=c.simd.M;${body}}`;
  }
  return null;
}

// ---------- expansión en línea de accesos a memoria y a la pila x87 ----------
// V8 deja de "inlinear" llamadas cuando el bloque generado es grande; estas expansiones evitan la llamada
// en el caso común (acceso alineado, página sin código compilado) y caen en el método original si no.
// Cada ocurrencia usa temporales propios (_tN) para que las expresiones anidadas no se pisen.
const MEM_INLINE = {
  'm.r32(': (A, T) => `(${T}=(${A})>>>0,(${T}&3)===0&&${T}>=4096&&${T}<1073741824?U32[${T}>>>2]:m.r32(${T}))`,
  'm.r16(': (A, T) => `(${T}=(${A})>>>0,(${T}&1)===0&&${T}>=4096&&${T}<1073741824?U16[${T}>>>1]:m.r16(${T}))`,
  'm.f32(': (A, T) => `(${T}=(${A})>>>0,(${T}&3)===0&&${T}>=4096&&${T}<1073741824?F32[${T}>>>2]:m.f32(${T}))`,
  'm.f64(': (A, T) => `(${T}=(${A})>>>0,(${T}&7)===0&&${T}>=4096&&${T}<1073741824?F64[${T}>>>3]:m.f64(${T}))`,
  'f.get(': (A) => `ST[(FP.top+(${A}))&7]`,
  'f.pop(': (A, T) => `(${T}=FP.top,TG[${T}]=1,FP.top=(${T}+1)&7,ST[${T}])`,
};
const MEM_INLINE2 = {
  'm.w32(': (A, V, T, U) => `(${U}=${V},${T}=(${A})>>>0,((${T}&3)===0&&${T}>=4096&&${T}<1073741824&&FW&&CP[${T}>>>12]===0)?(U32[${T}>>>2]=${U}):m.w32(${T},${U}))`,
  'm.w16(': (A, V, T, U) => `(${U}=${V},${T}=(${A})>>>0,((${T}&1)===0&&${T}>=4096&&${T}<1073741824&&FW&&CP[${T}>>>12]===0)?(U16[${T}>>>1]=${U}):m.w16(${T},${U}))`,
  'm.wf32(': (A, V, T, U) => `(${U}=${V},${T}=(${A})>>>0,((${T}&3)===0&&${T}>=4096&&${T}<1073741824&&FW&&CP[${T}>>>12]===0)?(F32[${T}>>>2]=${U}):m.wf32(${T},${U}))`,
  'm.wf64(': (A, V, T, U) => `(${U}=${V},${T}=(${A})>>>0,((${T}&7)===0&&${T}>=4096&&${T}<1073741824&&FW&&CP[${T}>>>12]===0)?(F64[${T}>>>3]=${U}):m.wf64(${T},${U}))`,
  'f.set(': (A, V, T, U) => `(${U}=${V},${T}=(FP.top+(${A}))&7,ST[${T}]=${U},TG[${T}]=0)`,
};
// devuelve [argumentos de nivel superior, índice del ')' de cierre]
function args(src, i) {
  let depth = 0, start = i; const out = [];
  for (; i < src.length; i++) { const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { out.push(src.slice(start, i)); return [out, i]; } depth--; }
    else if (ch === ',' && depth === 0) { out.push(src.slice(start, i)); start = i + 1; } }
  return null;
}
function inlineOps(src) {
  let n = 0;
  const keys = [...Object.keys(MEM_INLINE), ...Object.keys(MEM_INLINE2), 'f.push('];
  const rewrite = (s) => {
    let out = '', i = 0;
    for (;;) {
      let best = -1, key = null;
      for (const k of keys) { const j = s.indexOf(k, i); if (j >= 0 && (best < 0 || j < best) && (j === 0 || !/[\w.$]/.test(s[j - 1]))) { best = j; key = k; } }
      if (best < 0) { out += s.slice(i); return out; }
      const r = args(s, best + key.length); if (!r) { out += s.slice(i); return out; }
      const [a, end] = r; const A = a.map(rewrite);
      out += s.slice(i, best);
      if (MEM_INLINE[key] && A.length === (key === 'f.pop(' ? 1 : 1)) { const T = `_t${n++}`; out += MEM_INLINE[key](A[0], T); }
      else if (MEM_INLINE2[key] && A.length === 2) { const T = `_t${n++}`, U = `_t${n++}`; out += MEM_INLINE2[key](A[0], A[1], T, U); }
      else if (key === 'f.push(' && A.length === 1) { const U = `_t${n++}`; out += `(${U}=${A[0]},FP.top=(FP.top-1)&7,ST[FP.top]=${U},TG[FP.top]=0)`; }
      else out += s.slice(best, end + 1);
      i = end + 1;
    }
  };
  const body = rewrite(src);
  if (!n && body === src) return src;
  let decl = 'const U32=m.u32,U16=m.u16,F32=m.f32a,F64=m.f64a,CP=m.codePages,FW=m.noFastW!==true,FP=c.fpu,ST=FP.st,TG=FP.tagEmpty;';
  if (n) decl += 'let ' + Array.from({ length: n }, (_, k) => `_t${k}`).join(',') + ';';
  return decl + body;
}

// ---------- registros x86 en variables locales ----------
// Dentro de un bloque/región los 8 registros viven en locales ($0..$7); se vuelcan a c.r antes de cualquier
// salida (return / fin) y alrededor de las llamadas que leen o escriben registros (intérprete, imulSet, etc.).
const SYNC = '(r[0]=$0,r[1]=$1,r[2]=$2,r[3]=$3,r[4]=$4,r[5]=$5,r[6]=$6,r[7]=$7)';
const LOAD = '($0=r[0],$1=r[1],$2=r[2],$3=r[3],$4=r[4],$5=r[5],$6=r[6],$7=r[7])';
const BARRIERS = ['c.step(', 'c.getReg(', 'c.setReg(', 'c.imulSet(', 'c.fpu.exec('];
function cacheRegs(src) {
  let out = '', i = 0, k = 0;
  for (;;) {
    let best = -1, key = null;
    for (const b of BARRIERS) { const j = src.indexOf(b, i); if (j >= 0 && (best < 0 || j < best)) { best = j; key = b; } }
    if (best < 0) { out += src.slice(i); break; }
    const r = args(src, best + key.length); if (!r) { out += src.slice(i); break; }
    const call = src.slice(best, r[1] + 1); const T = `_rq${k++}`;
    out += src.slice(i, best) + `(@SYNC@,${T}=${call},@LOAD@,${T})`;
    i = r[1] + 1;
  }
  out = wrapRegWrites(out);
  out = out.replace(/\br\[([0-7])\]/g, (m, d) => '$' + d).replace(/return;/g, '{@SYNC@;return;}');
  const fp = out.includes('FP.top') || out.includes('c.fpu.top');
  if (fp) out = out.split('FP.top').join('$T').split('c.fpu.top').join('$T');
  out = out.split('@SYNC@').join(fp ? SYNC.slice(0, -1) + ',c.fpu.top=$T)' : SYNC).split('@LOAD@').join(fp ? LOAD.slice(0, -1) + ',$T=c.fpu.top)' : LOAD);
  const decl = `let $0=r[0],$1=r[1],$2=r[2],$3=r[3],$4=r[4],$5=r[5],$6=r[6],$7=r[7]${fp ? ',$T=c.fpu.top' : ''}` + (k ? ',' + Array.from({ length: k }, (_, j) => `_rq${j}`).join(',') : '') + ';';
  return decl + out + `;${fp ? SYNC.slice(0, -1) + ',c.fpu.top=$T)' : SYNC};`;
}

// `r[k]=EXPR` -> `r[k]=(EXPR)>>>0`: con locales hay que normalizar a uint32 como hacía el Uint32Array
function wrapRegWrites(src) {
  let out = '', i = 0; const re = /\br\[([0-7])\]=(?!=)/g; let mt;
  while ((mt = re.exec(src))) {
    const st = mt.index + mt[0].length; let depth = 0, j = st;
    for (; j < src.length; j++) { const ch = src[j];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      else if ((ch === ';' || ch === ',') && depth === 0) break; }
    out += src.slice(i, st) + `(${src.slice(st, j)})>>>0`; i = j; re.lastIndex = j;
  }
  return out + src.slice(i);
}
