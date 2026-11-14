// Resume un .cpuprofile de V8: tiempo propio por función JS y por bloque x86 (sourceURL blk_xxxx).
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[2])); const byId = new Map(p.nodes.map((n) => [n.id, n])); const t = new Map();
p.samples.forEach((id, i) => t.set(id, (t.get(id) || 0) + (p.timeDeltas[i] || 0)));
const self = new Map(); let tot = 0;
for (const [id, d] of t) { const cf = byId.get(id).callFrame; const u = cf.url.split('/').pop(); const k = (u.startsWith('blk_') || u.startsWith('reg_')) ? u.replace('.js', '') : `${cf.functionName || '(anon)'} ${u}:${cf.lineNumber}`; self.set(k, (self.get(k) || 0) + d); tot += d; }
const blocks = [...self].filter(([k]) => /^(blk|reg)_/.test(k)); const bt = blocks.reduce((a, [, v]) => a + v, 0);
console.log(`total ${(tot / 1e6).toFixed(1)}s; bloques x86 ${(100 * bt / tot).toFixed(1)}%`);
console.log([...self].filter(([k]) => !/^(blk|reg)_/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${(100 * v / tot).toFixed(1)}% ${k}`).join('\n'));
// bloques agrupados por región de 256 bytes
const reg = new Map(); for (const [k, v] of blocks) { const a = parseInt(k.slice(4), 16); const r = a >>> 8 << 8; reg.set(r, (reg.get(r) || 0) + v); }
console.log('--- regiones x86 (256 B) ---'); console.log([...reg].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${(100 * v / tot).toFixed(1)}% ${k.toString(16)}`).join('\n'));
