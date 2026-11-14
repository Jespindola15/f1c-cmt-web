// Lockstep, parte 1: corre F1C hasta la instrucción START (con JIT), guarda el estado completo (memoria no nula,
// registros, x87, SIMD) y luego ejecuta N instrucciones de a una registrando EIP + registros + flags.
//   node tools/lockstep-dump.mjs <juego> <START> <N> <salida>
import fs from 'node:fs';
import { patchConfig } from '../src/f1c-config.js';
import { Emulator } from '../src/emulator.js';
import { DiskVFS } from './disk-vfs.mjs';
import { MODULES } from '../src/emulator.js';
const [GAME, START, N, OUT] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];
const emu = new Emulator({ log: () => {}, host: { deferPresent: true, present() {}, setMode() {}, setTitle() {}, audio: { play() {}, stop() {}, update() {}, setVolume() {}, setPan() {}, setRate() {} } } });
emu.traceApis = false; emu.logFiles = false; emu.instrPerMs = 1e6; emu.qpcTurboMs = 0.02;
emu.vfs = new DiskVFS(GAME); emu.vfs.index.delete('OPH.DLL'); emu.vfs.index.delete('VFXDRIVE.DLL');
emu.vfs.add('Config.ini', new TextEncoder().encode(patchConfig(fs.readFileSync(GAME + '/Config.ini', 'latin1'))));
const ch = MODULES['KERNEL32.DLL'].CloseHandle; const orig = ch.fn;
ch.fn = (e, h, ...a) => { const o = e.handles.get(h); if (o?.name && /MAINBK\.JPG$/i.test(o.name)) console.log(`CloseHandle JPG "${o.name}" en instr=${e.cpu.icount}`); return orig(e, h, ...a); };
emu.loadMain(new Uint8Array(fs.readFileSync(GAME + '/F1C_CMT.exe')), 'F1C_CMT.EXE');
while (emu.cpu.icount < START) { const r = emu.run(Math.min(20_000_000, START - emu.cpu.icount)); if (r.status !== 'running') { console.log('parado', r.status, emu.cpu.icount); process.exit(1); } }
if (!N) process.exit(0);
const c = emu.cpu, m = emu.mem;
// --- estado ---
const pages = []; for (let p = 0; p < m.size; p += 4096) { const u = m.u8.subarray(p, p + 4096); if (u.some((x) => x)) pages.push(p); }
const f = c.fpu; const st = []; for (let i = 0; i < 8; i++) st.push(f.st[i]);
const state = { icount: c.icount, eip: c.eip, r: [...c.r], eflags: c.eflags, fsBase: c.fsBase, fpu: { st, top: f.top, cw: f.cw, tagEmpty: [...f.tagEmpty], status: f.status() },
  xmm: Buffer.from(c.simd.xbuf).toString('hex'), mm: Buffer.from(c.simd.mbuf).toString('hex'), mxcsr: c.simd.mxcsr, pages: pages.length };
fs.writeFileSync(OUT + '.state.json', JSON.stringify(state));
const fd = fs.openSync(OUT + '.mem', 'w'); const hdr = Buffer.alloc(4); for (const p of pages) { hdr.writeUInt32LE(p); fs.writeSync(fd, hdr); fs.writeSync(fd, m.u8.subarray(p, p + 4096)); } fs.closeSync(fd);
console.log(`estado guardado en instr=${c.icount} eip=0x${c.eip.toString(16)} páginas=${pages.length}`);
// --- traza de a una instrucción (intérprete) ---
// registra escrituras a memoria hechas por las APIs (para reproducirlas en Unicorn)
let apiWrites = null; const wl = [];
for (const name of ['w8', 'w16', 'w32', 'writeBytes', 'fill', 'writeCStr']) { const o = m[name].bind(m);
  m[name] = (a, ...rest) => { const r = o(a, ...rest); if (apiWrites) { const len = name === 'w8' ? 1 : name === 'w16' ? 2 : name === 'w32' ? 4 : name === 'writeBytes' ? rest[0].length : name === 'fill' ? rest[1] : Math.min(rest[1] ?? 260, (rest[0]?.length ?? 0) + 1); apiWrites.push([a >>> 0, Buffer.from(m.u8.subarray(a, a + len))]); } return r; }; }
emu.useJit = false; const rec = Buffer.alloc(44 * 65536); let k = 0; const tfd = fs.openSync(OUT + '.trace', 'w'); let n = 0;
for (; n < N; n++) {
  const inApi = c.eip >= 0x100000 && c.eip < 0x110000; if (inApi) apiWrites = [];
  const r = emu.run(1);
  if (inApi) { for (const [a, b] of apiWrites) wl.push([n, a, b]); apiWrites = null; }
  rec.writeUInt32LE(c.eip >>> 0, k); for (let i = 0; i < 8; i++) rec.writeUInt32LE(c.r[i] >>> 0, k + 4 + 4 * i); rec.writeUInt32LE(c.eflags >>> 0, k + 36); rec.writeUInt32LE(c.icount >>> 0, k + 40); k += 44;
  if (k === rec.length) { fs.writeSync(tfd, rec); k = 0; }
  if (r.status !== 'running') { console.log('parado en la traza', r.status, 'tras', n + 1); n++; break; }
}
fs.writeSync(tfd, rec.subarray(0, k)); fs.closeSync(tfd);
{ const parts = []; for (const [step, a, b] of wl) { const h = Buffer.alloc(12); h.writeUInt32LE(step); h.writeUInt32LE(a, 4); h.writeUInt32LE(b.length, 8); parts.push(h, b); } fs.writeFileSync(OUT + '.writes', Buffer.concat(parts)); console.log('escrituras de APIs:', wl.length); } console.log(`traza: ${n} instrucciones`);
