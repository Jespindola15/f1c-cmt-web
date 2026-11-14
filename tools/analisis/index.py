import os,struct,json,sys
root=sys.argv[1]
files={}   # lower relpath -> size
masidx={}  # lower mas relpath -> list of (name,raw,comp)
for dp,dn,fn in os.walk(root):
    for f in fn:
        p=os.path.join(dp,f); rel=os.path.relpath(p,root).replace('\\','/')
        try: s=os.path.getsize(p)
        except: continue
        files[rel]=s
        if f.lower().endswith('.mas'):
            try:
                with open(p,'rb') as fh:
                    h=fh.read(24)
                    if h[:11]!=b'CUBEMAS4.10': masidx[rel]='BADHDR:'+h[:12].decode('latin1'); continue
                    cnt=struct.unpack('<I',h[16:20])[0]; ents=[]
                    for i in range(cnt):
                        e=fh.read(256); fl,off,raw,comp,unk=struct.unpack('<IIIII',e[:20])
                        ents.append((e[20:].split(b'\0')[0].decode('latin1'),raw,comp))
                    masidx[rel]=ents
            except Exception as ex: masidx[rel]='ERR '+str(ex)
json.dump({'files':files,'mas':masidx},open(os.path.expanduser('~/tools/index.json'),'w'))
print(len(files),'files',sum(files.values())/1e9,'GB;',len(masidx),'MAS', 'bad:',[k for k,v in masidx.items() if isinstance(v,str)][:10])
