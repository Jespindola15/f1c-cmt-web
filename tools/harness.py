# Prueba minima de arranque: carga F1C_CMT.exe en un emulador x86 (Unicorn) con una capa Win32 HLE.
# Lee la instalacion en modo solo-lectura; toda escritura va a ~/f1c/overlay.
import sys, os, struct, time, json, fnmatch, collections, pefile
from unicorn import *
from unicorn.x86_const import *
GAME = os.path.expanduser('~/mnt/F1 Challenge 2025 CMT')
OVL  = os.path.expanduser('~/f1c/overlay'); os.makedirs(OVL, exist_ok=True)
WINROOT = 'C:\\F1C\\'
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
LOAD_OPH = '--oph' in sys.argv
MAXSEC = float(os.environ.get('MAXSEC','60'))
log = open(os.path.expanduser('~/f1c/trace.log'),'w')
def L(*a):
    s=' '.join(str(x) for x in a); log.write(s+'\n')
mu = Uc(UC_ARCH_X86, UC_MODE_32)
PAGE=0x1000
def align(x,a=PAGE): return (x+a-1)&~(a-1)
mapped=[]
def mmap(addr,size,perm=UC_PROT_ALL):
    size=align(size); mu.mem_map(addr,size,perm); mapped.append((addr,size))
# ---------- regiones ----------
STUB=0x7f000000; mmap(STUB,0x100000)
STACK_TOP=0x00300000; mmap(0x00100000,0x00200000)   # 2 MB de pila
HEAP=0x40000000; HEAP_SIZE=0x30000000; mmap(HEAP,HEAP_SIZE)  # 768 MB heap (lazy)
heap_ptr=[HEAP]; heap_sizes={}
def halloc(n,zero=True):
    n=max(16,align(n,16)); p=heap_ptr[0]; heap_ptr[0]+=n+16
    if heap_ptr[0]>HEAP+HEAP_SIZE: raise Exception('heap agotado')
    heap_sizes[p]=n
    return p
VA_NEXT=[0x20000000]
# ---------- TEB / FS via GDT ----------
GDT=0x80000000; mmap(GDT,0x1000)
TEB=0x7ffd0000; mmap(TEB,0x2000); PEB=0x7ffd2000; mmap(PEB,0x1000)
def gdt_entry(base,limit,access,flags):
    e = limit & 0xffff; e |= (base & 0xffffff) << 16; e |= (access & 0xff) << 40
    e |= ((limit >> 16) & 0xf) << 48; e |= (flags & 0xf) << 52; e |= ((base >> 24) & 0xff) << 56
    return struct.pack('<Q',e)
mu.mem_write(GDT+8*1, gdt_entry(0,0xfffff,0x9a,0xc))   # code
mu.mem_write(GDT+8*2, gdt_entry(0,0xfffff,0x92,0xc))   # data
mu.mem_write(GDT+8*3, gdt_entry(TEB,0xfff,0x92,0x4))   # fs
mu.mem_write(GDT+8*4, gdt_entry(0,0xfffff,0x92|0x0,0xc)) # ss (ring0 data)
mu.reg_write(UC_X86_REG_GDTR,(0,GDT,0x1000,0x0))
mu.reg_write(UC_X86_REG_SS,(4<<3))
mu.reg_write(UC_X86_REG_DS,(2<<3)); mu.reg_write(UC_X86_REG_ES,(2<<3))
mu.reg_write(UC_X86_REG_FS,(3<<3))
mu.mem_write(TEB, struct.pack('<IIIIII',0xffffffff,STACK_TOP,0x00100000,0,0,0))
mu.mem_write(TEB+0x18, struct.pack('<I',TEB)); mu.mem_write(TEB+0x30, struct.pack('<I',PEB))
mu.mem_write(TEB+0x24, struct.pack('<I',0x100))  # thread id
# ---------- util ----------
def r32(a): return struct.unpack('<I',mu.mem_read(a,4))[0]
def w32(a,v): mu.mem_write(a,struct.pack('<I',v&0xffffffff))
def cstr(a,maxn=1024):
    if not a: return None
    out=b''
    while len(out)<maxn:
        try: chunk=bytes(mu.mem_read(a+len(out),16))
        except UcError:
            chunk=b''
            for i in range(16):
                try: chunk+=bytes(mu.mem_read(a+len(out)+i,1))
                except UcError: chunk+=b'\0'; break
        out+=chunk
        if b'\0' in chunk: break
    return out.split(b'\0')[0].decode('latin1')
def wstr(a,maxn=1024):
    if not a: return None
    b=bytes(mu.mem_read(a,maxn*2)); i=0
    while i<len(b)-1 and b[i:i+2]!=b'\0\0': i+=2
    return b[:i].decode('utf-16le','replace')
def put_cstr(a,s,n=None):
    b=s.encode('latin1')+b'\0'
    if n is not None: b=b[:n]
    mu.mem_write(a,b)
def newstr(s): p=halloc(len(s)+1); put_cstr(p,s); return p
# ---------- VFS ----------
gfiles={}
for dp,dn,fn in os.walk(GAME):
    for n in dn+fn:
        p=os.path.join(dp,n); rel=os.path.relpath(p,GAME).replace('\\','/'); gfiles[rel.lower()]=rel
cwd=['']  # relativo a la raiz del juego
def norm(path):
    p=path.replace('/','\\')
    if p.lower().rstrip('\\')==WINROOT.lower().rstrip('\\'): p=''; return ''
    if p.lower().startswith(WINROOT.lower()): p=p[len(WINROOT):]
    elif len(p)>1 and p[1]==':': return None  # otra unidad
    elif not p.startswith('\\'): p=(cwd[0]+'\\'+p) if cwd[0] else p
    parts=[]
    for x in p.split('\\'):
        if x in ('','.'): continue
        if x=='..':
            if parts: parts.pop()
            continue
        parts.append(x)
    return '/'.join(parts)
def host(rel, write=False):
    if rel is None: return None
    o=os.path.join(OVL,rel.lower())
    if os.path.exists(o) or write: return o
    real=gfiles.get(rel.lower())
    return os.path.join(GAME,real) if real else None
files_opened=collections.OrderedDict(); files_missing=collections.OrderedDict(); files_written=collections.OrderedDict()
handles={}; hnext=[0x1000]
def newh(obj): h=hnext[0]; hnext[0]+=4; handles[h]=obj; return h
# ---------- import stubs ----------
stub_names={}; stub_by_name={}
FAST={'EnterCriticalSection':b'\xc2\x04\x00','LeaveCriticalSection':b'\xc2\x04\x00','InitializeCriticalSection':b'\xc2\x04\x00','DeleteCriticalSection':b'\xc2\x04\x00'}
fast_next=[STUB+0x80000]
def get_stub(dll,name):
    key=(dll.lower(),name)
    if key in stub_by_name: return stub_by_name[key]
    if name in FAST:
        a=fast_next[0]; fast_next[0]+=8; mu.mem_write(a,FAST[name]); stub_by_name[key]=a; return a
    a=STUB+len(stub_names)*8; mu.mem_write(a,b'\xc3'); stub_names[a]=key; stub_by_name[key]=a; return a
# ---------- PE loader ----------
modules={}  # lower name -> dict(base, pe, exports)
def load_pe(path, name):
    pe=pefile.PE(path); base=pe.OPTIONAL_HEADER.ImageBase; size=align(pe.OPTIONAL_HEADER.SizeOfImage)
    taken=any(not(base+size<=a or base>=a+s) for a,s in mapped)
    if taken:
        nb=VA_NEXT[0]; VA_NEXT[0]+=align(size,0x10000); delta=nb-base; base=nb
    else: delta=0
    mmap(base,size)
    mu.mem_write(base, pe.get_memory_mapped_image()[:size] if False else pe.header)
    for s in pe.sections:
        d=s.get_data()[:max(s.Misc_VirtualSize,s.SizeOfRawData)]
        mu.mem_write(base+s.VirtualAddress, d[:size-s.VirtualAddress])
    if delta and hasattr(pe,'DIRECTORY_ENTRY_BASERELOC'):
        for blk in pe.DIRECTORY_ENTRY_BASERELOC:
            for e in blk.entries:
                if e.type==3: a=base+e.rva; w32(a,r32(a)+delta)
    exports={}
    if hasattr(pe,'DIRECTORY_ENTRY_EXPORT'):
        for e in pe.DIRECTORY_ENTRY_EXPORT.symbols:
            if e.name: exports[e.name.decode()]=base+e.address
            exports['#%d'%e.ordinal]=base+e.address
    m=dict(base=base,pe=pe,exports=exports,name=name,entry=base+pe.OPTIONAL_HEADER.AddressOfEntryPoint)
    modules[name.lower()]=m
    if hasattr(pe,'DIRECTORY_ENTRY_IMPORT'):
        for imp in pe.DIRECTORY_ENTRY_IMPORT:
            dll=imp.dll.decode()
            for i in imp.imports:
                nm=i.name.decode() if i.name else '#%d'%i.ordinal
                target=resolve_import(dll,nm)
                w32(base+(i.address-pe.OPTIONAL_HEADER.ImageBase), target)
    L('LOAD',name,hex(base),'delta',hex(delta))
    return m
REAL_DLLS=set()  # dlls cargadas como codigo x86 real
def resolve_import(dll,nm):
    m=modules.get(dll.lower())
    if m and dll.lower() in REAL_DLLS:
        return m['exports'].get(nm) or get_stub(dll,nm)
    return get_stub(dll,nm)
# ---------- carga del exe ----------
exe=load_pe(os.path.join(GAME,'F1C_CMT.exe'),'F1C_CMT.exe')
IMAGE=exe['base']
# ---------- llamadas API ----------
api_count=collections.Counter(); first_calls=[]
STOP=[None]
pending_ret=[]
class Ret(Exception): pass
def args(n):
    esp=mu.reg_read(UC_X86_REG_ESP); return [r32(esp+4+4*i) for i in range(n)]
def do_ret(val,nargs):
    esp=mu.reg_read(UC_X86_REG_ESP); ret=r32(esp)
    mu.reg_write(UC_X86_REG_EAX,val&0xffffffff); mu.reg_write(UC_X86_REG_ESP,esp+4+4*nargs); mu.reg_write(UC_X86_REG_EIP,ret)
last_error=[0]; tls={}; tls_next=[0]
sys.path.insert(0,os.path.expanduser('~/f1c')); from hle import API   # tabla de implementaciones
def on_stub(uc,addr,size,ud):
    key=stub_names.get(addr)
    if key is None: return
    dll,name=key; api_count[dll+'!'+name]+=1
    if len(first_calls)<4000: first_calls.append(dll+'!'+name)
    fn=API.get(dll+'::'+name) or API.get(name)
    if fn is None and '@' in name:
        n=int(name.split('@')[1])//4
        L('STUB-DECORATED',dll,name,'-> 0'); do_ret(0,n); return
    if fn is None:
        L('UNIMPLEMENTED',dll,name,'args',[hex(x) for x in args(4)]); STOP[0]='unimplemented %s!%s'%(dll,name); uc.emu_stop(); return
    try: fn(G)
    except StopIteration as e:
        STOP[0]=str(e); uc.emu_stop()
    except Exception as e:
        import traceback; L('PYERR in',dll,name,traceback.format_exc()); STOP[0]='python error in %s!%s: %r'%(dll,name,e); uc.emu_stop()
class GObj: pass
G=GObj(); G.__dict__.update(globals())
G.milestones=[]
G.milestone=lambda m: G.milestones.append((m, round(time.time()-t0,2), blocks[0], sum(api_count.values())))
t0=time.time()
mu.hook_add(UC_HOOK_CODE,on_stub,begin=STUB,end=STUB+0x7ffff)
stub_names[STUB+0x7fff0]=('__exit__','__exit__')
blocks=[0]; insns=[0]
def on_block(uc,addr,size,ud): blocks[0]+=1
# block hook desactivado (costoso)
def on_bad(uc,access,addr,size,val,ud):
    L('MEM-FAULT',access,hex(addr),'eip',hex(uc.reg_read(UC_X86_REG_EIP))); return False
mu.hook_add(UC_HOOK_MEM_UNMAPPED,on_bad)
# PEB minimo
w32(PEB+8,IMAGE)
esp=STACK_TOP-0x100; w32(esp,STUB+0x7fff0); mu.reg_write(UC_X86_REG_ESP,esp)
stub_names[STUB+0xFFFF0]=('__exit__','__exit__')
t0=time.time()
try:
    mu.emu_start(exe['entry'],0,timeout=int(MAXSEC*1e6))
except UcError as e:
    STOP[0]=STOP[0] or ('UcError %s at eip %s'%(e,hex(mu.reg_read(UC_X86_REG_EIP))))
dt=time.time()-t0
res=dict(stop=STOP[0] or 'timeout/fin', seconds=round(dt,2), blocks=blocks[0], api_calls=sum(api_count.values()),
  distinct_apis=len(api_count), eip=hex(mu.reg_read(UC_X86_REG_EIP)),
  files_opened=list(files_opened), files_missing=list(files_missing), files_written=list(files_written),
  api_top=api_count.most_common(60), first_calls=first_calls[:300], milestones=G.__dict__.get('milestones',[]))
json.dump(res,open(os.path.expanduser('~/f1c/result.json'),'w'),indent=1)
print(json.dumps({k:res[k] for k in ('stop','seconds','blocks','api_calls','distinct_apis','eip','milestones')},indent=1))
print('opened',len(res['files_opened']),'missing',len(res['files_missing']),'written',len(res['files_written']))
