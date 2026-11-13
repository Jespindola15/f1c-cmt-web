import json,os,re,sys,collections
root=sys.argv[1]; idx=json.load(open(os.path.expanduser('~/tools/index.json')))
files=idx['files']; mas=idx['mas']
by_base=collections.defaultdict(list)
for rel in files: by_base[os.path.basename(rel).lower()].append(rel)
in_mas=collections.defaultdict(list)
for m,ents in mas.items():
    if isinstance(ents,list):
        for n,raw,comp in ents: in_mas[n.lower()].append(m)
EXT='mas|mts|gmt|bmp|tga|dds|jpg|wav|mp3|ogg|bik|scn|gdb|aiw|cam|cin|veh|hdv|gen|sfx|tbc|pm|ini|osc|anm|pcd|gtl|dic|txt|cfg|plr|rcd|fnt|ffb|svm|csv|lua|f1c|eng'
pat=re.compile(r'([A-Za-z0-9_\-\.\\/ \(\)&]+?\.(?:%s))\b'%EXT, re.I)
TEXT=('.gdb','.scn','.veh','.hdv','.gen','.sfx','.ini','.osc','.plr','.cfg','.tbc','.pm','.cam','.cin','.gtl','.pcd','.dic','.txt','.lua')
def read_text(rel):
    try: return open(os.path.join(root,rel),'rb').read().decode('latin1')
    except: return ''
need=set(); needmas=set(); missing=collections.Counter(); seen=set()
queue=[]
def add(rel):
    if rel in seen: return
    seen.add(rel); need.add(rel)
    if rel.lower().endswith(TEXT) or rel.upper().endswith('EALOAD.MAS'): queue.append(rel)
def resolve(name, ctx):
    b=os.path.basename(name.replace('\\','/')).strip().lower()
    if '<' in name or '*' in name or not b: return
    hits=by_base.get(b)
    if hits:
        # prefer same top dir as context
        top=ctx.split('/')[0]
        sel=[h for h in hits if h.split('/')[0]==top] or hits
        for h in sel[:3]: add(h)
        return
    if b in in_mas:
        for m in in_mas[b][:3]: needmas.add(m); add(m)
        return
    missing[b]+=1
# roots
roots=['Config.ini','CMTOptions/F12K2.osc','CMTOptions/EALOAD.MAS','CMTSave/Player1/Player1.plr','CMTSave/default.cfg']
roots+=[r for r in files if r.startswith('CMTSeasonData/') and r.count('/')==1 and r.lower().endswith('.gdb')]
for r in roots: add(r)
# tracks in SceneOrder of season GDBs
for g in [r for r in roots if r.lower().endswith('.gdb')]:
    t=read_text(g); so=re.search(r'SceneOrder\s*\{(.*?)\}',t,re.S)
    if so:
        for name in re.findall(r'^\s*([A-Za-z0-9_]+)\s*$',so.group(1),re.M):
            for r in files:
                if os.path.basename(r).lower()==name.lower()+'.gdb': 
                    add(r); d=os.path.dirname(r)
                    for ext in ('.scn','.aiw','.cam','.cin'):
                        p=d+'/'+name+ext
                        for f2 in files:
                            if f2.lower()==p.lower(): add(f2)
# vehicles in class
for r in files:
    if r.lower().endswith('.veh'):
        t=read_text(r); c=re.search(r'Classes\s*=\s*"([^"]*)"',t)
        if c and re.search(r'2025CMT|2025Z',c.group(1)): add(r)
while queue:
    rel=queue.pop(); t=read_text(rel)
    t=re.sub(r'//[^\n]*','',t)
    for m in pat.findall(t): resolve(m, rel)
tot=collections.Counter(); nd=collections.Counter()
def top(r): 
    p=r.split('/'); return '/'.join(p[:2]) if p[0]=='CMTSeasonData' and len(p)>2 else p[0] if len(p)>1 else '(raíz)'
for r,s in files.items(): tot[top(r)]+=s
for r in need: nd[top(r)]+=files[r]
print('needed files',len(need),'MB',round(sum(files[r] for r in need)/1e6),'of',round(sum(files.values())/1e6))
for k in sorted(tot,key=lambda k:-tot[k]): print(f'{k:40s} total {tot[k]/1e6:9.1f} MB  referenced {nd[k]/1e6:9.1f} MB')
print('MAS referenced',len([r for r in need if r.lower().endswith('.mas')]),'of',len(mas))
print('unreferenced MAS:',sorted(r for r in mas if r not in need)[:60])
print('missing refs (top):',missing.most_common(40))
json.dump(sorted(need),open(os.path.expanduser('~/tools/needed.json'),'w'))
