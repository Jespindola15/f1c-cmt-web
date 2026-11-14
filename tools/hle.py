import os, time, struct, fnmatch
API={}
def api(n, nargs=None):
    def deco(f):
        API[n]=(lambda G: f(G, *G.args(nargs)) if nargs is not None else f(G)); API[n].nargs=nargs; return f
    return deco
def simple(name,nargs,val=0):
    API[name]=lambda G: G.do_ret(val,nargs)
T0=time.time()
def ms(): return int((time.time()-T0)*1000)+100000
# ---------------- KERNEL32: proceso / CRT ----------------
@api('GetVersion',0)
def _(G): G.do_ret(0x0A280105,0)   # XP 5.1 build 2600
@api('GetVersionExA',1)
def _(G,p):
    G.mu.mem_write(p+4, struct.pack('<IIII',5,1,2600,2)); G.put_cstr(p+20,'Service Pack 3'); G.do_ret(1,1)
CMDLINE=[None]
@api('GetCommandLineA',0)
def _(G):
    if not CMDLINE[0]: CMDLINE[0]=G.newstr('"C:\\F1C\\F1C_CMT.exe" '+' '.join(G.ARGS))
    G.do_ret(CMDLINE[0],0)
@api('GetStartupInfoA',1)
def _(G,p): G.mu.mem_write(p,b'\0'*68); G.w32(p,68); G.do_ret(0,1)
@api('GetModuleHandleA',1)
def _(G,p):
    n=G.cstr(p)
    if n is None: return G.do_ret(G.IMAGE,1)
    m=G.modules.get(n.lower()) or G.modules.get(n.lower()+'.dll')
    G.do_ret(m['base'] if m else fake_module(G,n),1)
FAKE={}
def fake_module(G,n):
    n=n.lower()
    if not n.endswith('.dll'): n+='.dll'
    if n not in FAKE: FAKE[n]=0x7e000000+len(FAKE)*0x10000
    return FAKE[n]
@api('GetModuleFileNameA',3)
def _(G,h,buf,n):
    s='C:\\F1C\\F1C_CMT.exe'; G.put_cstr(buf,s,n); G.do_ret(len(s),3)
@api('GetProcAddress',2)
def _(G,h,p):
    name = G.cstr(p) if p>0xffff else '#%d'%p
    for m in G.modules.values():
        if m['base']==h and name in m['exports']: return G.do_ret(m['exports'][name],2)
    dll=[k for k,v in FAKE.items() if v==h]
    dll=dll[0] if dll else '?'
    G.L('GetProcAddress',dll,name)
    G.do_ret(G.get_stub(dll,name),2)
LOADED=[]
@api('LoadLibraryA',1)
def _(G,p):
    n=G.cstr(p); LOADED.append(n); G.L('LoadLibraryA',n)
    low=n.lower().split('\\')[-1]
    if low in ('oph.dll','vfxdrive.dll'):
        if not G.LOAD_OPH: G.last_error[0]=126; return G.do_ret(0,1)
    if low in ('d3d8d.dll',): return G.do_ret(0,1)
    G.do_ret(fake_module(G,low),1)
simple('FreeLibrary',1,1)
@api('ExitProcess',1)
def _(G,c): raise StopIteration('ExitProcess(%d)'%c)
@api('TerminateProcess',2)
def _(G,h,c): raise StopIteration('TerminateProcess(%d)'%c)
@api('GetEnvironmentStrings',0)
def _(G): G.do_ret(G.newstr('PATH=C:\\Windows\0\0'),0)
@api('GetEnvironmentStringsW',0)
def _(G):
    p=G.halloc(64); G.mu.mem_write(p,'PATH=C:\\Windows\0\0'.encode('utf-16le')); G.do_ret(p,0)
simple('FreeEnvironmentStringsA',1,1); simple('FreeEnvironmentStringsW',1,1)
@api('GetEnvironmentVariableA',3)
def _(G,n,b,s): G.do_ret(0,3)
simple('SetEnvironmentVariableA',2,1)
@api('GetStdHandle',1)
def _(G,n): G.do_ret(0x10+((n^0xffffffff)&0xf),1)
@api('GetFileType',1)
def _(G,h): G.do_ret(2 if h<0x20 else 1,1)
simple('SetHandleCount',1,32); simple('SetStdHandle',2,1)
simple('GetACP',0,1252); simple('GetOEMCP',0,437); simple('IsValidCodePage',1,1); simple('IsValidLocale',2,1)
@api('GetCPInfo',2)
def _(G,cp,p): G.mu.mem_write(p,struct.pack('<I',1)+b'?\0'+b'\0'*12); G.do_ret(1,2)
simple('GetUserDefaultLCID',0,0x409)
@api('GetLocaleInfoA',4)
def _(G,lc,t,buf,n):
    s='1252' if t==0x1004 else '0'
    if n: G.put_cstr(buf,s,n)
    G.do_ret(len(s)+1,4)
simple('GetLocaleInfoW',4,0); simple('EnumSystemLocalesA',2,1)
@api('MultiByteToWideChar',6)
def _(G,cp,fl,src,cb,dst,cch):
    s=G.cstr(src) if cb==0xffffffff else bytes(G.mu.mem_read(src,cb)).decode('latin1')
    if cb==0xffffffff: s+='\0'
    if cch: G.mu.mem_write(dst,s.encode('utf-16le')[:cch*2])
    G.do_ret(len(s),6)
@api('WideCharToMultiByte',8)
def _(G,cp,fl,src,cch,dst,cb,d1,d2):
    s=G.wstr(src) if cch==0xffffffff else bytes(G.mu.mem_read(src,cch*2)).decode('utf-16le')
    if cch==0xffffffff: s+='\0'
    if cb: G.mu.mem_write(dst,s.encode('latin1','replace')[:cb])
    G.do_ret(len(s),8)
@api('LCMapStringA',6)
def _(G,lc,fl,src,cb,dst,cbd):
    s=bytes(G.mu.mem_read(src,cb if cb!=0xffffffff else len(G.cstr(src))+1))
    if fl & 0x100: s=s.lower()
    if fl & 0x200: s=s.upper()
    if cbd: G.mu.mem_write(dst,s[:cbd])
    G.do_ret(len(s),6)
@api('LCMapStringW',6)
def _(G,lc,fl,src,cc,dst,ccd):
    n=cc if cc!=0xffffffff else len(G.wstr(src))+1
    s=bytes(G.mu.mem_read(src,n*2))
    if ccd: G.mu.mem_write(dst,s[:ccd*2])
    G.do_ret(n,6)
@api('GetStringTypeA',5)
def _(G,lc,t,src,cb,out):
    n=cb if cb!=0xffffffff else len(G.cstr(src))+1
    data=bytes(G.mu.mem_read(src,n)); G.mu.mem_write(out,b''.join(struct.pack('<H',ctype(c)) for c in data)); G.do_ret(1,5)
@api('GetStringTypeW',4)
def _(G,t,src,cc,out):
    n=cc if cc!=0xffffffff else len(G.wstr(src))+1
    data=bytes(G.mu.mem_read(src,n*2)); G.mu.mem_write(out,b''.join(struct.pack('<H',ctype(data[i])) for i in range(0,len(data),2))); G.do_ret(1,4)
def ctype(c):
    ch=chr(c); v=0
    if ch.isupper(): v|=1
    if ch.islower(): v|=2
    if ch.isdigit(): v|=4
    if ch in ' \t\r\n\v\f': v|=8
    if ch in '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~': v|=0x10
    if c<32 or c==127: v|=0x20
    if ch==' ': v|=0x40
    if ch in '0123456789abcdefABCDEF': v|=0x80
    if ch.isalpha(): v|=0x100
    return v
@api('CompareStringA',6)
def _(G,lc,fl,a,na,b,nb):
    sa=G.cstr(a) if na==0xffffffff else bytes(G.mu.mem_read(a,na)).decode('latin1')
    sb=G.cstr(b) if nb==0xffffffff else bytes(G.mu.mem_read(b,nb)).decode('latin1')
    if fl&1: sa,sb=sa.lower(),sb.lower()
    G.do_ret(1 if sa<sb else 3 if sa>sb else 2,6)
simple('CompareStringW',6,2)
# ---------------- memoria ----------------
@api('HeapCreate',3)
def _(G,a,b,c): G.do_ret(0x00500000,3)
simple('HeapDestroy',1,1)
@api('HeapAlloc',3)
def _(G,h,f,n): G.do_ret(G.halloc(n),3)
@api('HeapFree',3)
def _(G,h,f,p): G.do_ret(1,3)
@api('HeapSize',3)
def _(G,h,f,p): G.do_ret(G.heap_sizes.get(p,0xffffffff),3)
@api('HeapReAlloc',4)
def _(G,h,f,p,n):
    old=G.heap_sizes.get(p,0); q=G.halloc(n)
    if p and old: G.mu.mem_write(q,bytes(G.mu.mem_read(p,min(old,n))))
    G.do_ret(q,4)
@api('GetProcessHeap',0)
def _(G): G.do_ret(0x00500000,0)
@api('VirtualAlloc',4)
def _(G,addr,size,typ,prot):
    if addr and any(a<=addr<a+s for a,s in G.mapped): return G.do_ret(addr,4)
    size=G.align(size,0x10000); a=G.VA_NEXT[0]; G.VA_NEXT[0]+=size; G.mmap(a,size); G.do_ret(a,4)
simple('VirtualFree',3,1); simple('VirtualProtect',4,1)
@api('LocalAlloc',2)
def _(G,f,n): G.do_ret(G.halloc(n),2)
simple('LocalFree',1,0)
@api('GlobalMemoryStatus',1)
def _(G,p): G.mu.mem_write(p,struct.pack('<IIIIIIII',32,20,0x7fff0000,0x60000000,0xffff0000,0xc0000000,0x7ffe0000,0x60000000)); G.do_ret(0,1)
simple('IsBadReadPtr',2,0); simple('IsBadWritePtr',2,0); simple('IsBadCodePtr',1,0)
# ---------------- hilos / sync ----------------
@api('GetLastError',0)
def _(G): G.do_ret(G.last_error[0],0)
@api('SetLastError',1)
def _(G,e): G.last_error[0]=e; G.do_ret(0,1)
@api('TlsAlloc',0)
def _(G): i=G.tls_next[0]; G.tls_next[0]+=1; G.do_ret(i,0)
@api('TlsGetValue',1)
def _(G,i): G.do_ret(G.tls.get(i,0),1)
@api('TlsSetValue',2)
def _(G,i,v): G.tls[i]=v; G.do_ret(1,2)
simple('TlsFree',1,1)
for n in ('InitializeCriticalSection','EnterCriticalSection','LeaveCriticalSection','DeleteCriticalSection'): simple(n,1,0)
simple('GetCurrentThreadId',0,0x100); simple('GetCurrentProcessId',0,0x200)
simple('GetCurrentThread',0,0xfffffffe); simple('GetCurrentProcess',0,0xffffffff)
@api('InterlockedIncrement',1)
def _(G,p): v=(G.r32(p)+1)&0xffffffff; G.w32(p,v); G.do_ret(v,1)
@api('InterlockedDecrement',1)
def _(G,p): v=(G.r32(p)-1)&0xffffffff; G.w32(p,v); G.do_ret(v,1)
@api('InterlockedExchange',2)
def _(G,p,v): o=G.r32(p); G.w32(p,v); G.do_ret(o,2)
THREADS=[]
@api('CreateThread',6)
def _(G,sa,ss,start,param,flags,tid):
    THREADS.append((hex(start),hex(param),flags)); G.L('CreateThread',hex(start),hex(param),flags)
    if tid: G.w32(tid,0x300+len(THREADS))
    G.do_ret(0x5000+len(THREADS),6)
simple('SetThreadPriority',2,1); simple('ResumeThread',1,1); simple('SuspendThread',1,0); simple('QueueUserAPC',3,1)
simple('SetPriorityClass',2,1); simple('GetPriorityClass',1,0x20)
@api('CreateMutexA',3)
def _(G,a,o,n): G.L('CreateMutexA',G.cstr(n)); G.last_error[0]=0; G.do_ret(0x6000,3)
simple('ReleaseMutex',1,1); simple('WaitForSingleObject',2,0); simple('CloseHandle',1,1); simple('DuplicateHandle',7,1)
simple('Sleep',1,0); simple('SleepEx',2,0)
simple('SetUnhandledExceptionFilter',1,0); simple('UnhandledExceptionFilter',1,0)
simple('IsProcessorFeaturePresent',1,1); simple('IsDebuggerPresent',0,0)
@api('RaiseException',4)
def _(G,c,f,n,a): raise StopIteration('RaiseException 0x%x'%c)
@api('OutputDebugStringA',1)
def _(G,p): G.L('ODS',G.cstr(p)); G.do_ret(0,1)
@api('GetSystemInfo',1)
def _(G,p): G.mu.mem_write(p,struct.pack('<HHIIIIIIIHH',0,0,0x1000,0x10000,0x7ffeffff,1,1,586,0x10000,6,0x0f00)); G.do_ret(0,1)
# ---------------- tiempo ----------------
@api('GetTickCount',0)
def _(G): G.do_ret(ms(),0)
@api('QueryPerformanceFrequency',1)
def _(G,p): G.mu.mem_write(p,struct.pack('<Q',1000000)); G.do_ret(1,1)
@api('QueryPerformanceCounter',1)
def _(G,p): G.mu.mem_write(p,struct.pack('<Q',int((time.time()-T0)*1e6)+10**9)); G.do_ret(1,1)
def systime():
    t=time.gmtime(); return struct.pack('<8H',t.tm_year,t.tm_mon,(t.tm_wday+1)%7,t.tm_mday,t.tm_hour,t.tm_min,t.tm_sec,0)
@api('GetLocalTime',1)
def _(G,p): G.mu.mem_write(p,systime()); G.do_ret(0,1)
@api('GetSystemTime',1)
def _(G,p): G.mu.mem_write(p,systime()); G.do_ret(0,1)
@api('GetSystemTimeAsFileTime',1)
def _(G,p): G.mu.mem_write(p,struct.pack('<Q',int((time.time()+11644473600)*1e7))); G.do_ret(0,1)
@api('GetTimeZoneInformation',1)
def _(G,p): G.mu.mem_write(p,b'\0'*172); G.do_ret(0,1)
@api('FileTimeToLocalFileTime',2)
def _(G,a,b): G.mu.mem_write(b,bytes(G.mu.mem_read(a,8))); G.do_ret(1,2)
@api('FileTimeToSystemTime',2)
def _(G,a,b): G.mu.mem_write(b,systime()); G.do_ret(1,2)
simple('CompareFileTime',2,0)
# ---------------- archivos (VFS solo lectura + overlay) ----------------
class FH:
    def __init__(s,f,rel): s.f=f; s.rel=rel
@api('GetCurrentDirectoryA',2)
def _(G,n,buf):
    s='C:\\F1C'+('\\'+G.cwd[0] if G.cwd[0] else ''); G.put_cstr(buf,s,n); G.do_ret(len(s),2)
@api('SetCurrentDirectoryA',1)
def _(G,p):
    rel=G.norm(G.cstr(p)); G.L('SetCurrentDirectory',G.cstr(p))
    if rel is None: return G.do_ret(0,1)
    G.cwd[0]=rel.replace('/','\\'); G.do_ret(1,1)
@api('GetFullPathNameA',4)
def _(G,p,n,buf,fp):
    rel=G.norm(G.cstr(p)); s=G.WINROOT+(rel or '').replace('/','\\')
    G.put_cstr(buf,s,n)
    if fp: G.w32(fp,buf+s.rfind('\\')+1)
    G.do_ret(len(s),4)
@api('CreateFileA',7)
def _(G,p,acc,share,sa,disp,fl,tmpl):
    path=G.cstr(p); rel=G.norm(path); write=bool(acc&0x40000000)
    if rel is None:
        G.files_missing[path]=1; G.last_error[0]=3; return G.do_ret(0xffffffff,7)
    if write:
        h=G.host(rel,write=True); os.makedirs(os.path.dirname(h),exist_ok=True)
        src=G.host(rel)
        mode='r+b' if (disp in (3,4) and os.path.exists(h)) else 'w+b'
        if disp in (3,4) and not os.path.exists(h) and src and os.path.exists(src):
            open(h,'wb').write(open(src,'rb').read()); mode='r+b'
        G.files_written[rel]=1; G.L('CreateFile(W)',path)
        return G.do_ret(G.newh(FH(open(h,mode),rel)),7)
    h=G.host(rel)
    if not h or os.path.isdir(h):
        G.files_missing[path]=1; G.L('CreateFile MISSING',path); G.last_error[0]=2; return G.do_ret(0xffffffff,7)
    G.files_opened[rel]=1; G.L('CreateFile',path)
    G.do_ret(G.newh(FH(open(h,'rb'),rel)),7)
@api('ReadFile',5)
def _(G,h,buf,n,pread,ov):
    o=G.handles.get(h)
    if not isinstance(o,FH): return G.do_ret(0,5)
    d=o.f.read(n); G.mu.mem_write(buf,d)
    if pread: G.w32(pread,len(d))
    G.do_ret(1,5)
@api('WriteFile',5)
def _(G,h,buf,n,pw,ov):
    o=G.handles.get(h)
    if isinstance(o,FH): o.f.write(bytes(G.mu.mem_read(buf,n)))
    elif h<0x20: G.L('STDOUT',bytes(G.mu.mem_read(buf,n)).decode('latin1'))
    if pw: G.w32(pw,n)
    G.do_ret(1,5)
@api('SetFilePointer',4)
def _(G,h,dist,hi,how):
    o=G.handles.get(h)
    if not isinstance(o,FH): return G.do_ret(0xffffffff,4)
    d=dist if dist<0x80000000 else dist-0x100000000
    o.f.seek(d,how); G.do_ret(o.f.tell(),4)
@api('SetEndOfFile',1)
def _(G,h):
    o=G.handles.get(h)
    if isinstance(o,FH): o.f.truncate()
    G.do_ret(1,1)
simple('FlushFileBuffers',1,1)
@api('GetFileAttributesA',1)
def _(G,p):
    path=G.cstr(p); rel=G.norm(path); h=G.host(rel)
    if not h: G.files_missing[path]=1; return G.do_ret(0xffffffff,1)
    G.do_ret(0x10 if os.path.isdir(h) else 0x80,1)
simple('SetFileAttributesA',2,1)
@api('GetFileInformationByHandle',2)
def _(G,h,p):
    o=G.handles.get(h); size=os.fstat(o.f.fileno()).st_size if isinstance(o,FH) else 0
    G.mu.mem_write(p,b'\0'*52); G.w32(p,0x80); G.w32(p+32,0); G.w32(p+36,size); G.do_ret(1,2)
@api('CreateDirectoryA',2)
def _(G,p,sa):
    rel=G.norm(G.cstr(p))
    if rel is not None: os.makedirs(os.path.join(G.OVL,rel.lower()),exist_ok=True); G.files_written[rel+'/']=1
    G.do_ret(1,2)
simple('RemoveDirectoryA',1,1)
@api('DeleteFileA',1)
def _(G,p): G.L('DeleteFile',G.cstr(p)); G.do_ret(1,1)
@api('MoveFileA',2)
def _(G,a,b):
    ra,rb=G.norm(G.cstr(a)),G.norm(G.cstr(b)); G.L('MoveFile',G.cstr(a),G.cstr(b))
    ha=os.path.join(G.OVL,ra.lower()); hb=os.path.join(G.OVL,rb.lower())
    if os.path.exists(ha): os.makedirs(os.path.dirname(hb),exist_ok=True); os.replace(ha,hb); G.files_written[rb]=1
    G.do_ret(1,2)
@api('CopyFileA',3)
def _(G,a,b,f): G.L('CopyFile',G.cstr(a),G.cstr(b)); G.do_ret(1,3)
simple('GetDriveTypeA',1,3)
class FIND:
    def __init__(s,items): s.items=items; s.i=0
def fill_find(G,p,name,isdir,size):
    G.mu.mem_write(p,b'\0'*320); G.w32(p,0x10 if isdir else 0x80); G.w32(p+32,size); G.put_cstr(p+44,name,260)
def listdir(G,rel):
    out={}
    real=G.gfiles.get(rel.lower()) if rel else ''
    if real is not None:
        d=os.path.join(G.GAME,real)
        if os.path.isdir(d):
            for n in os.listdir(d): out[n.lower()]=(n,os.path.join(d,n))
    o=os.path.join(G.OVL,rel.lower())
    if os.path.isdir(o):
        for n in os.listdir(o): out[n.lower()]=(n,os.path.join(o,n))
    return list(out.values())
FINDLOG=[]
@api('FindFirstFileA',2)
def _(G,p,data):
    path=G.cstr(p); rel=G.norm(path) or ''; FINDLOG.append(path)
    d,_,pat=rel.rpartition('/')
    pp=pat.lower(); pp='*' if pp in ('*.*','*') else pp
    items=[(n,h) for n,h in listdir(G,d) if fnmatch.fnmatch(n.lower(),pp)]
    G.L('FindFirstFile',path,len(items))
    if not items: G.last_error[0]=2; return G.do_ret(0xffffffff,2)
    n,h=items[0]; fill_find(G,data,n,os.path.isdir(h),0 if os.path.isdir(h) else os.path.getsize(h))
    G.do_ret(G.newh(FIND(items)),2)
@api('FindNextFileA',2)
def _(G,h,data):
    o=G.handles.get(h)
    if not isinstance(o,FIND): return G.do_ret(0,2)
    o.i+=1
    if o.i>=len(o.items): G.last_error[0]=18; return G.do_ret(0,2)
    n,hp=o.items[o.i]; fill_find(G,data,n,os.path.isdir(hp),0 if os.path.isdir(hp) else os.path.getsize(hp)); G.do_ret(1,2)
simple('FindClose',1,1)
simple('PeekNamedPipe',6,0)
@api('CreateProcessA',10)
def _(G,*a): G.L('CreateProcessA',G.cstr(a[0]),G.cstr(a[1])); G.do_ret(0,10)
# ---------------- ADVAPI32 ----------------
@api('RegOpenKeyA',3)
def _(G,k,p,out): G.L('RegOpenKeyA',hex(k),G.cstr(p)); G.do_ret(2,3)
@api('RegQueryValueExA',6)
def _(G,*a): G.do_ret(2,6)
simple('RegCloseKey',1,0)
for n,k in (('OpenProcessToken',3),('OpenThreadToken',4),('ImpersonateSelf',1),('RevertToSelf',0),('AllocateAndInitializeSid',11),
            ('InitializeSecurityDescriptor',2),('InitializeAcl',3),('AddAccessAllowedAce',4),('SetSecurityDescriptorDacl',4),
            ('SetSecurityDescriptorGroup',3),('SetSecurityDescriptorOwner',3),('IsValidSecurityDescriptor',1)): simple(n,k,1)
simple('FreeSid',1,0); simple('GetLengthSid',1,12)
@api('AccessCheck',8)
def _(G,sd,tok,acc,gm,ps,psl,granted,status):
    G.w32(granted,acc); G.w32(status,1); G.do_ret(1,8)
@api('SHGetSpecialFolderPathA',4)
def _(G,h,buf,csidl,c): G.put_cstr(buf,'C:\\F1C\\Users'); G.do_ret(1,4)
# ---------------- USER32 / GDI ----------------
simple('GetStockObject',1,0x8000)
simple('LoadIconA',2,0x9001); simple('LoadImageA',6,0x9002); simple('DestroyCursor',1,1); simple('SetCursor',1,0); simple('ShowCursor',1,0)
@api('RegisterClassA',1)
def _(G,p): G.L('RegisterClassA'); G.do_ret(0xc001,1)
@api('RegisterClassExA',1)
def _(G,p): G.L('RegisterClassExA'); G.do_ret(0xc002,1)
simple('UnregisterClassA',2,1)
@api('CreateWindowExA',12)
def _(G,*a):
    G.L('CreateWindowExA',G.cstr(a[1]) if a[1]>0xffff else a[1],G.cstr(a[2]),[hex(x) for x in a[4:8]])
    G.milestone('CreateWindowExA'); G.do_ret(0xA000,12)
simple('ShowWindow',2,1); simple('SetForegroundWindow',1,1); simple('DestroyWindow',1,1); simple('ClipCursor',1,1)
simple('GetDesktopWindow',0,0xA0F0); simple('AdjustWindowRectEx',4,1)
@api('GetClientRect',2)
def _(G,h,p): G.mu.mem_write(p,struct.pack('<iiii',0,0,1024,768)); G.do_ret(1,2)
@api('MessageBoxA',4)
def _(G,h,t,c,f): G.L('MessageBox',G.cstr(c),'|',G.cstr(t)); raise StopIteration('MessageBox: %s | %s'%(G.cstr(c),G.cstr(t)))
PEEKS=[0]
@api('PeekMessageA',5)
def _(G,*a):
    PEEKS[0]+=1
    if PEEKS[0]==1: G.milestone('primer PeekMessageA (bucle principal)')
    if PEEKS[0]>=int(os.environ.get('MAXPEEK','2000')): raise StopIteration('bucle principal alcanzado (%d PeekMessage)'%PEEKS[0])
    G.do_ret(0,5)
simple('GetMessageA',4,0); simple('TranslateMessage',1,0); simple('DispatchMessageA',1,0); simple('PostQuitMessage',1,0)
simple('DefWindowProcA',4,0)
simple('GetKeyboardLayout',1,0x04090409); simple('GetKeyboardState',1,1); simple('MapVirtualKeyExA',3,0); simple('ToAsciiEx',6,0)
# ---------------- WinSock ----------------
@api('WSAStartup',2)
def _(G,v,p): G.mu.mem_write(p,b'\0'*400); G.w32(p,0x0101); G.L('WSAStartup'); G.do_ret(0,2)
simple('WSACleanup',0,0)
@api('gethostbyname',1)
def _(G,p): G.L('gethostbyname',G.cstr(p)); G.do_ret(0,1)
@api('#52',1)
def _(G,p): G.L('gethostbyname#52',G.cstr(p)); G.do_ret(0,1)
# ---------------- AVI ----------------
simple('AVIFileExit',0,0)
# ---------------- Direct3D 8 / DirectInput 8 ----------------
@api('Direct3DCreate8',1)
def _(G,sdk):
    G.L('Direct3DCreate8 sdk',sdk); G.milestone('Direct3DCreate8(SDK=%d)'%sdk)
    if os.environ.get('D3D')!='com': raise StopIteration('Direct3DCreate8 alcanzado')
    G.do_ret(make_com(G,'IDirect3D8',D3D8),1)
@api('DirectInput8Create',5)
def _(G,hinst,ver,riid,out,unk):
    G.L('DirectInput8Create ver',hex(ver)); G.milestone('DirectInput8Create')
    G.w32(out,make_com(G,'IDirectInput8A',15)); G.do_ret(0,5)
COMCALLS=[]
def make_com(G,iface,names):
    if isinstance(names,int): names=['m%d'%i for i in range(names)]
    obj=G.halloc(8); vt=G.halloc(4*len(names)); G.w32(obj,vt)
    for i,n in enumerate(names): G.w32(vt+4*i,G.get_stub(iface.lower(),n))
    return obj
def com(iface,name,nargs,val=0):   # nargs incluye this
    def deco(f):
        API[iface.lower()+'::'+name]=lambda G: f(G,*G.args(nargs)); return f
    return deco
D3D8=['QueryInterface','AddRef','Release','RegisterSoftwareDevice','GetAdapterCount','GetAdapterIdentifier','GetAdapterModeCount','EnumAdapterModes','GetAdapterDisplayMode','CheckDeviceType','CheckDeviceFormat','CheckDeviceMultiSampleType','CheckDepthStencilMatch','GetDeviceCaps','GetMonitor','CreateDevice']
D3DLOG=[]
MODES=[]
for fmt in (23,22):
    for (w,h) in ((640,480),(800,600),(1024,768),(1152,864),(1280,720),(1280,768),(1280,800),(1280,960),(1280,1024),(1360,768),(1366,768),(1440,900),(1600,900),(1600,1200),(1680,1050),(1920,1080),(1920,1200),(2560,1440)):
        for hz in (60,75):
            MODES.append((w,h,hz,fmt))
def dl(G,*a): D3DLOG.append(' '.join(str(x) for x in a)); G.L('D3D',*a)
@com('IDirect3D8','AddRef',1)
def _(G,this): G.do_ret(1,1)
@com('IDirect3D8','Release',1)
def _(G,this): G.do_ret(0,1)
@com('IDirect3D8','GetAdapterCount',1)
def _(G,this): dl(G,'GetAdapterCount'); G.do_ret(1,1)
@com('IDirect3D8','GetAdapterIdentifier',4)
def _(G,this,ad,fl,p):
    dl(G,'GetAdapterIdentifier',ad,hex(fl)); G.mu.mem_write(p,b'\0'*1064)
    G.put_cstr(p,'webgl2.dll'); G.put_cstr(p+512,'WebGL2 (navegador)')
    import struct as S; G.mu.mem_write(p+1024,S.pack('<QIIII',0x0006000E000A0000,0x10DE,0x0F00,0,0))
    G.mu.mem_write(p+1048,bytes.fromhex('e21eb7d79f24cf11ec70c9525cc2d635')); G.do_ret(0,4)
@com('IDirect3D8','GetAdapterModeCount',2)
def _(G,this,ad): dl(G,'GetAdapterModeCount ->',len(MODES)); G.do_ret(len(MODES),2)
@com('IDirect3D8','EnumAdapterModes',4)
def _(G,this,ad,i,p):
    import struct as S
    if i>=len(MODES): return G.do_ret(0x8876086C,4)
    G.mu.mem_write(p,S.pack('<IIII',*MODES[i])); G.do_ret(0,4)
@com('IDirect3D8','GetAdapterDisplayMode',3)
def _(G,this,ad,p):
    import struct as S; G.mu.mem_write(p,S.pack('<IIII',1920,1080,60,22)); dl(G,'GetAdapterDisplayMode'); G.do_ret(0,3)
@com('IDirect3D8','CheckDeviceType',6)
def _(G,this,ad,dt,dfmt,bfmt,win): dl(G,'CheckDeviceType',dt,dfmt,bfmt,win); G.do_ret(0,6)
@com('IDirect3D8','CheckDeviceFormat',7)
def _(G,this,ad,dt,afmt,usage,rtype,fmt):
    ok = fmt in (20,21,22,23,24,25,26,28,50,51,0x31545844,0x32545844,0x33545844,0x34545844,0x35545844,75,77,80)
    dl(G,'CheckDeviceFormat usage=%x rtype=%d fmt=%s -> %s'%(usage,rtype,hex(fmt),'OK' if ok else 'NO')); G.do_ret(0 if ok else 0x8876086A,7)
@com('IDirect3D8','CheckDeviceMultiSampleType',6)
def _(G,this,ad,dt,fmt,win,ms): dl(G,'CheckDeviceMultiSampleType',ms); G.do_ret(0 if ms in (0,2,4) else 0x8876086A,6)
@com('IDirect3D8','CheckDepthStencilMatch',6)
def _(G,this,ad,dt,afmt,rfmt,dsfmt): dl(G,'CheckDepthStencilMatch',dsfmt); G.do_ret(0,6)
@com('IDirect3D8','GetDeviceCaps',4)
def _(G,this,ad,dt,p):
    import struct as S
    dl(G,'GetDeviceCaps',dt)
    c=bytearray(212)
    def d(off,v): c[off:off+4]=S.pack('<I',v&0xffffffff)
    def f(off,v): c[off:off+4]=S.pack('<f',v)
    d(0,dt); d(8,0x20000); d(12,0xE0000000); d(16,0x20); d(20,0x8000000F); d(24,3)
    d(28,0x001BFEF0)   # DevCaps: HWTRANSFORMANDLIGHT, HWRASTERIZATION, DRAWPRIMTLVERTEX...
    d(32,0x2FF2); d(36,0x0F732191); d(40,0xFF); d(44,0x1FFF); d(48,0x1FFF); d(52,0xFF); d(56,0x42A4A)
    d(60,0x0001EC45); d(64,0x03030700); d(68,0x0303); d(72,0x0303); d(76,0x3F); d(80,0x3F); d(84,0x1F)
    d(88,4096); d(92,4096); d(96,512); d(100,8192); d(104,8192); d(108,16)
    f(112,1e10); f(116,-1e8); f(120,-1e8); f(124,1e8); f(128,1e8); f(132,0)
    d(136,0xFF); d(140,0x00080008); d(144,0x03FFFFFF); d(148,8); d(152,4); d(156,0x3B); d(160,8); d(164,6)
    d(168,4); d(172,0); f(176,64.0); d(180,0xFFFFF); d(184,0xFFFFFF); d(188,16); d(192,255)
    d(196,0xFFFE0101); d(200,96); d(204,0xFFFF0104); f(208,8.0)
    G.mu.mem_write(p,bytes(c)); G.do_ret(0,4)
@com('IDirect3D8','GetMonitor',2)
def _(G,this,ad): G.do_ret(0x12340000,2)
CREATE=[]
@com('IDirect3D8','CreateDevice',7)
def _(G,this,ad,dt,hwnd,flags,pp,out):
    import struct as S
    v=S.unpack('<13I',bytes(G.mu.mem_read(pp,52)))
    names=['BackBufferWidth','BackBufferHeight','BackBufferFormat','BackBufferCount','MultiSampleType','SwapEffect','hDeviceWindow','Windowed','EnableAutoDepthStencil','AutoDepthStencilFormat','Flags','FullScreen_RefreshRateInHz','FullScreen_PresentationInterval']
    fl=[n for b,n in ((2,'FPU_PRESERVE'),(4,'MULTITHREADED'),(0x10,'PUREDEVICE'),(0x20,'SOFTWARE_VERTEXPROCESSING'),(0x40,'HARDWARE_VERTEXPROCESSING'),(0x80,'MIXED_VERTEXPROCESSING')) if flags&b]
    info=dict(adapter=ad,devtype=dt,flags=hex(flags),flag_names=fl,present=dict(zip(names,[hex(x) if i in (6,10) else x for i,x in enumerate(v)])))
    CREATE.append(info); dl(G,'CreateDevice',info); G.milestone('IDirect3D8::CreateDevice %s'%fl)
    import json; json.dump(dict(create=CREATE,log=D3DLOG),open(os.path.expanduser('~/f1c/d3d.json'),'w'),indent=1)
    raise StopIteration('CreateDevice alcanzado')

@api('__exit__',0)
def _(G): raise StopIteration('main() retorno')
