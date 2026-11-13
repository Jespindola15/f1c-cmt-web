# Genera casos de prueba SIMD y los ejecuta en Unicorn (referencia). Salida: cases.json
import random, struct, json, keystone
from unicorn import *
from unicorn.x86_const import *
random.seed(98765)
ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)
CODE, DATA = 0x1000000, 0x2000000
X = ['xmm%d' % i for i in range(8)]; M = ['mm%d' % i for i in range(8)]
def xr(): return random.choice(X)
def mr(): return random.choice(M)
T = []  # plantillas: (texto, tipo_datos)
F32 = 'f32'; F64 = 'f64'; INT = 'int'
def add(fmt, kind, regs='x', mem=True, imm=None):
    T.append((fmt, kind, regs, mem, imm))
# movimientos
for m in ['movups','movaps','movupd','movapd','movdqu','movdqa']: add(m+' {d}, {s}', INT); T.append((m+' {m}, {d}', INT, 'x', 'store', None))
for m in ['movss']: add(m+' {d}, {s}', F32); T.append((m+' {m}, {d}', F32,'x','store',None))
for m in ['movsd']: add(m+' {d}, {s}', F64); T.append((m+' {m}, {d}', F64,'x','store',None))
for m in ['movlps','movhps','movlpd','movhpd']: T.append((m+' {d}, {m}', INT,'x','memonly',None)); T.append((m+' {m}, {d}', INT,'x','store',None))
for m in ['movhlps','movlhps']: T.append((m+' {d}, {s}', INT,'x','regonly',None))
for m in ['unpcklps','unpckhps','unpcklpd','unpckhpd','punpcklqdq','punpckhqdq']: add(m+' {d}, {s}', INT)
add('shufps {d}, {s}, {i}', INT, imm=True); add('shufpd {d}, {s}, {i}', INT, imm=True)
# aritmética float
for m in ['addps','subps','mulps','divps','minps','maxps','sqrtps','andps','andnps','orps','xorps']: add(m+' {d}, {s}', F32)
for m in ['addss','subss','mulss','divss','minss','maxss','sqrtss']: add(m+' {d}, {s}', F32)
for m in ['addpd','subpd','mulpd','divpd','minpd','maxpd','sqrtpd','andpd','andnpd','orpd','xorpd']: add(m+' {d}, {s}', F64)
for m in ['addsd','subsd','mulsd','divsd','minsd','maxsd','sqrtsd']: add(m+' {d}, {s}', F64)
add('cmpps {d}, {s}, {i8}', F32, imm=True); add('cmpss {d}, {s}, {i8}', F32, imm=True); add('cmppd {d}, {s}, {i8}', F64, imm=True); add('cmpsd {d}, {s}, {i8}', F64, imm=True)
for m in ['ucomiss','comiss']: add(m+' {d}, {s}', F32)
for m in ['ucomisd','comisd']: add(m+' {d}, {s}', F64)
# conversiones
add('cvtps2pd {d}, {s}', F32); add('cvtpd2ps {d}, {s}', F64); add('cvtss2sd {d}, {s}', F32); add('cvtsd2ss {d}, {s}', F64)
add('cvtdq2ps {d}, {s}', INT); add('cvtps2dq {d}, {s}', F32); add('cvttps2dq {d}, {s}', F32); add('cvtdq2pd {d}, {s}', INT); add('cvttpd2dq {d}, {s}', F64); add('cvtpd2dq {d}, {s}', F64)
for m,k in [('cvttss2si',F32),('cvtss2si',F32),('cvttsd2si',F64),('cvtsd2si',F64)]: T.append((m+' {g}, {s}', k,'x','gdst',None))
for m in ['cvtsi2ss','cvtsi2sd']: T.append((m+' {d}, {gs}', INT,'x','gsrc',None))
for m in ['movmskps','movmskpd','pmovmskb']: T.append((m+' {g}, {s}', F32,'x','gdst_reg',None))
T.append(('pmovmskb {g}, {s}', INT,'m','gdst_reg',None))
# enteros (MMX y XMM)
INTOPS=['paddb','paddw','paddd','paddq','psubb','psubw','psubd','psubq','paddsb','paddsw','paddusb','paddusw','psubsb','psubsw','psubusb','psubusw',
 'pmullw','pmulhw','pmulhuw','pmuludq','pmaddwd','pavgb','pavgw','pminub','pmaxub','pminsw','pmaxsw','psadbw','pand','pandn','por','pxor',
 'pcmpeqb','pcmpeqw','pcmpeqd','pcmpgtb','pcmpgtw','pcmpgtd','packsswb','packssdw','packuswb',
 'punpcklbw','punpcklwd','punpckldq','punpckhbw','punpckhwd','punpckhdq','psrlw','psrld','psrlq','psraw','psrad','psllw','pslld','psllq']
for m in INTOPS: add(m+' {d}, {s}', INT, regs='x'); add(m+' {d}, {s}', INT, regs='m')
for m in ['psrlw','psrld','psrlq','psraw','psrad','psllw','pslld','psllq']:
    T.append((m+' {d}, {sh}', INT,'x','regonly',None)); T.append((m+' {d}, {sh}', INT,'m','regonly',None))
T.append(('psrldq {d}, {sh}', INT,'x','regonly',None)); T.append(('pslldq {d}, {sh}', INT,'x','regonly',None))
add('pshufd {d}, {s}, {i}', INT, imm=True); add('pshuflw {d}, {s}, {i}', INT, imm=True); add('pshufhw {d}, {s}, {i}', INT, imm=True); add('pshufw {d}, {s}, {i}', INT, regs='m', imm=True)
for r in 'xm':
    T.append(('movd {d}, {gs}', INT, r, 'gsrc', None)); T.append(('movd {gd}, {d}', INT, r, 'gstore', None))
    T.append(('pinsrw {d}, {gs}, {i3}', INT, r, 'gsrc', None)); T.append(('pextrw {g}, {s}, {i3}', INT, r, 'gdst_reg', None))
add('movq {d}, {s}', INT, regs='m'); T.append(('movq {m}, {d}', INT, 'm','store',None)); add('movq {d}, {s}', INT, regs='x'); T.append(('movq {m}, {d}', INT,'x','store',None))
add('movdq2q {d}, {s}', INT) if False else None
G = ['eax','ecx','edx','ebx','esi','edi']
def rnd_vec(kind, n=16):
    b = bytearray()
    while len(b) < n:
        r = random.random()
        if kind == F32:
            v = random.choice([random.uniform(-1000,1000), random.uniform(-3,3), 0.0, -0.0, 1.5, 2.5, -2.5, float('inf'), 1e30, 3e9, -0.5, 0.5]) if r < 0.9 else float('nan')
            b += struct.pack('<f', v)
        elif kind == F64:
            v = random.choice([random.uniform(-1e6,1e6), random.uniform(-3,3), 0.0, 1.5, 2.5, -2.5, 3e9, -3e9, 0.5, -0.5, float('inf')]) if r < 0.92 else float('nan')
            b += struct.pack('<d', v)
        else: b += random.getrandbits(32).to_bytes(4,'little')
    return bytes(b[:n])
cases = []
for (fmt, kind, regs, mode, imm) in T:
    for rep in range(36):
        R = M if regs == 'm' else X
        d = random.choice(R); s = random.choice(R)
        usemem = (mode in ('memonly','store')) or (mode is True and random.random() < 0.4) or (mode == 'gsrc' and random.random() < 0.3)
        if mode == 'regonly' or mode == 'gdst_reg' or mode=='gstore': usemem = False
        g = random.choice(G[1:]); gs = random.choice(G[1:])
        txt = fmt.format(d=d, s=('[eax+8]' if (usemem and mode not in ('store','gsrc')) else s), m='[eax+8]', i=random.randrange(256), i8=random.randrange(8), i3=random.randrange(8),
                         g=g, gs=('dword ptr [eax+8]' if (mode=='gsrc' and usemem) else gs), gd=random.choice(G[1:]), sh=random.choice([0,1,3,7,8,15,16,31,33,63,64,70]))
        if 'pinsrw' in txt and '[eax' in txt: txt = txt.replace('dword ptr', 'word ptr')
        try: enc, _ = ks.asm(txt)
        except Exception as e: print('ASM FAIL', txt, e); continue
        st = {'xmm': [rnd_vec(kind).hex() for _ in range(8)], 'mm': [rnd_vec(INT if kind!=F32 else F32, 8).hex() for _ in range(8)],
              'gpr': [random.getrandbits(32) for _ in range(8)], 'mem': rnd_vec(kind, 64).hex(), 'mxcsr': random.choice([0x1f80, 0x1f80, 0x3f80, 0x5f80, 0x7f80])}
        st['gpr'][0] = DATA; st['gpr'][4] = 0x3000f00
        if 'cvtsi2' in txt or 'movd' in txt or 'pinsrw' in txt:
            for i in range(1,8): st['gpr'][i] = random.choice([random.getrandbits(32), random.randrange(-1000,1000) & 0xffffffff])
        mu = Uc(UC_ARCH_X86, UC_MODE_32); mu.mem_map(CODE, 0x1000); mu.mem_map(DATA, 0x1000); mu.mem_map(0x3000000, 0x1000)
        code = bytes(enc)
        pre = bytes(ks.asm(';'.join('movq mm%d, qword ptr [0x%x]' % (i, 0x3000000 + 8*i) for i in range(8)))[0])
        post = bytes(ks.asm(';'.join('movq qword ptr [0x%x], mm%d' % (0x3000800 + 8*i, i) for i in range(8)))[0])
        mu.mem_write(0x3000000, b''.join(bytes.fromhex(x) for x in st['mm']))
        full = pre + code + post
        mu.mem_write(CODE, full); mu.mem_write(DATA, bytes.fromhex(st['mem']))
        for i, r in enumerate([UC_X86_REG_EAX,UC_X86_REG_ECX,UC_X86_REG_EDX,UC_X86_REG_EBX,UC_X86_REG_ESP,UC_X86_REG_EBP,UC_X86_REG_ESI,UC_X86_REG_EDI]): mu.reg_write(r, st['gpr'][i])
        for i in range(8): mu.reg_write(UC_X86_REG_XMM0+i, int.from_bytes(bytes.fromhex(st['xmm'][i]),'little'))
        mu.reg_write(UC_X86_REG_MXCSR, st['mxcsr'])
        try: mu.emu_start(CODE, CODE + len(full))
        except UcError as e: print('UC ERR', txt, e); continue
        out = {'xmm': [mu.reg_read(UC_X86_REG_XMM0+i).to_bytes(16,'little').hex() for i in range(8)],
               'mm': [bytes(mu.mem_read(0x3000800 + 8*i, 8)).hex() for i in range(8)],
               'gpr': [mu.reg_read(r) for r in [UC_X86_REG_EAX,UC_X86_REG_ECX,UC_X86_REG_EDX,UC_X86_REG_EBX,UC_X86_REG_ESP,UC_X86_REG_EBP,UC_X86_REG_ESI,UC_X86_REG_EDI]],
               'mem': bytes(mu.mem_read(DATA, 64)).hex(), 'eflags': mu.reg_read(UC_X86_REG_EFLAGS), 'mxcsr': mu.reg_read(UC_X86_REG_MXCSR), 'eip': CODE + len(code)}
        cases.append({'asm': txt, 'code': code.hex(), 'in': st, 'out': out, 'flags': 'ucomi' in txt or 'comi' in txt})
json.dump(cases, open('cases2.json','w'))
print('casos', len(cases), 'plantillas', len(T))
