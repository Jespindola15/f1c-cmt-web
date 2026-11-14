# Lockstep, parte 2: carga el estado del emulador JS en Unicorn y ejecuta de a una instrucción comparando
# EIP, registros y flags con la traza del emulador JS. Imprime la primera divergencia.
import sys, json, struct
from unicorn import *
from unicorn.x86_const import *
import capstone
P = sys.argv[1]
st = json.load(open(P + '.state.json'))
mu = Uc(UC_ARCH_X86, UC_MODE_32)
mu.mem_map(0, 0x40000000)
with open(P + '.mem', 'rb') as f:
    while True:
        h = f.read(4)
        if not h: break
        a = struct.unpack('<I', h)[0]; mu.mem_write(a, f.read(4096))
# GDT con FS -> TEB
GDT = 0x40000000 - 0x10000
def ent(base, limit, access, flags):
    e = limit & 0xffff; e |= (base & 0xffffff) << 16; e |= (access & 0xff) << 40; e |= ((limit >> 16) & 0xf) << 48; e |= (flags & 0xf) << 52; e |= ((base >> 24) & 0xff) << 56
    return struct.pack('<Q', e)
saved_gdt = bytes(mu.mem_read(GDT, 0x40))
mu.mem_write(GDT + 8, ent(0, 0xfffff, 0x9a, 0xc)); mu.mem_write(GDT + 16, ent(0, 0xfffff, 0x92, 0xc)); mu.mem_write(GDT + 24, ent(st['fsBase'], 0xfff, 0x92, 0x4))
mu.reg_write(UC_X86_REG_GDTR, (0, GDT, 0x40, 0)); mu.reg_write(UC_X86_REG_SS, 16); mu.reg_write(UC_X86_REG_DS, 16); mu.reg_write(UC_X86_REG_ES, 16); mu.reg_write(UC_X86_REG_FS, 24)
R = [UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX, UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI]
def set_regs(regs, eip, eflags):
    for i, r in enumerate(R): mu.reg_write(r, regs[i])
    mu.reg_write(UC_X86_REG_EIP, eip); mu.reg_write(UC_X86_REG_EFLAGS, eflags | 2)
set_regs(st['r'], st['eip'], st['eflags'])
# x87
def d2x(v):
    b = struct.unpack('<Q', struct.pack('<d', v))[0]; s = b >> 63; e = (b >> 52) & 0x7ff; m = b & ((1 << 52) - 1)
    if e == 0 and m == 0: return (0, s << 15)
    if e == 0x7ff: return ((1 << 63) | (m << 11), (s << 15) | 0x7fff)
    if e == 0: # denormal double -> normal en 80 bits
        ex = -1022
        while not (m & (1 << 52)): m <<= 1; ex -= 1
        return (m << 11, (s << 15) | (ex + 16383))
    return ((1 << 63) | (m << 11), (s << 15) | (e - 1023 + 16383))
fp = st['fpu']
for i in range(8): mu.reg_write(UC_X86_REG_FP0 + i, d2x(fp['st'][i]))
mu.reg_write(UC_X86_REG_FPCW, fp['cw']); mu.reg_write(UC_X86_REG_FPSW, (fp['status'] & ~0x3800) | ((fp['top'] & 7) << 11))
tag = 0
for i in range(8): tag |= (3 if fp['tagEmpty'][i] else 0) << (2 * i)
mu.reg_write(UC_X86_REG_FPTAG, tag)
xb = bytes.fromhex(st['xmm'])
for i in range(8): mu.reg_write(UC_X86_REG_XMM0 + i, int.from_bytes(xb[16*i:16*i+16], 'little'))
mu.reg_write(UC_X86_REG_MXCSR, st['mxcsr'])
# traza
tr = open(P + '.trace', 'rb').read(); n = len(tr) // 44
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
FLMASK = 0x8c5  # CF PF ZF SF OF
names = ['eax','ecx','edx','ebx','esp','ebp','esi','edi']
def dis(a):
    try:
        code = bytes(mu.mem_read(a, 16)); i = next(md.disasm(code, a)); return f'{i.mnemonic} {i.op_str}'
    except Exception as e: return '?'
prev_eip = st['eip']; hist = []
import os as _os
WATCH = int(_os.environ.get('WATCH', '0'), 16)
cur_step = [0]
if WATCH:
    def _hw(uc, acc, addr, size, val, ud):
        if addr <= WATCH < addr + size or WATCH <= addr < WATCH + 4:
            print(f'  escritura en 0x{addr:x} ({size} bytes) val=0x{val & 0xffffffff:x} paso {cur_step[0]} eip=0x{uc.reg_read(UC_X86_REG_EIP):x} {dis(uc.reg_read(UC_X86_REG_EIP))}')
    mu.hook_add(UC_HOOK_MEM_WRITE, _hw)
W = {}
try:
    wb = open(P + '.writes', 'rb').read(); o = 0
    while o < len(wb):
        step, a, ln = struct.unpack_from('<III', wb, o); o += 12; W.setdefault(step, []).append((a, wb[o:o + ln])); o += ln
except FileNotFoundError: pass
for k in range(n):
    eip_t, *rest = struct.unpack_from('<9II', tr, 44 * k)[:10], 
    vals = struct.unpack_from('<11I', tr, 44 * k); eip_t = vals[0]; regs_t = list(vals[1:9]); fl_t = vals[9]; ic = vals[10]
    cur = mu.reg_read(UC_X86_REG_EIP); cur_step[0] = k
    if 0x100000 <= cur < 0x110000:  # thunk de API: el emulador JS lo resolvió; copiar su resultado
        set_regs(regs_t, eip_t, fl_t); hist.append((cur, 'API'))
        for a, b in W.get(k, []): mu.mem_write(a, b)
        prev_eip = cur; continue
    ins = dis(cur)
    try:
        mu.emu_start(cur, 0, count=1)
        guard = 0
        while mu.reg_read(UC_X86_REG_EIP) == cur and guard < 10_000_000 and ins.startswith('rep'): mu.emu_start(cur, 0, count=1); guard += 1
    except UcError as e:
        print(f'Unicorn falló en paso {k} eip=0x{cur:x} {ins}: {e}'); break
    eip_u = mu.reg_read(UC_X86_REG_EIP); regs_u = [mu.reg_read(r) for r in R]; fl_u = mu.reg_read(UC_X86_REG_EFLAGS)
    hist.append((cur, ins)); hist = hist[-12:]
    diffs = []
    if eip_u != eip_t: diffs.append(f'eip U=0x{eip_u:x} JS=0x{eip_t:x}')
    for i in range(8):
        if regs_u[i] != regs_t[i]: diffs.append(f'{names[i]} U=0x{regs_u[i]:x} JS=0x{regs_t[i]:x}')
    mn = ins.split(' ')[0]; mask = FLMASK
    if mn in ('cpuid', 'rdtsc'): set_regs(regs_t, eip_t, fl_t); continue
    if mn in ('shl','shr','sar','sal','rol','ror','rcl','rcr','shld','shrd'): mask &= ~0x800  # OF indefinido si cuenta != 1
    if mn in ('mul','imul'): mask = 0x801
    if mn in ('div','idiv'): mask = 0
    if mn in ('bsf','bsr'): mask = 0x40
    if mn in ('bt','bts','btr','btc'): mask = 0x1
    if mn in ('and','or','xor','test'): mask &= ~0x10
    if (fl_u & mask) != (fl_t & mask): diffs.append(f'flags U=0x{fl_u & FLMASK:x} JS=0x{fl_t & FLMASK:x}')
    if not diffs: mu.reg_write(UC_X86_REG_EFLAGS, fl_t | 2)  # sincroniza flags indefinidos
    if diffs:
        print(f'PRIMERA DIVERGENCIA en paso {k} (instr {ic}) tras ejecutar 0x{cur:x}: {ins}')
        for d in diffs: print('   ', d)
        print('   bytes:', bytes(mu.mem_read(cur, 12)).hex())
        print('   anteriores:'); [print(f'     0x{a:x} {t}') for a, t in hist[:-1]]
        break
else:
    print(f'Sin divergencias en {n} instrucciones')
