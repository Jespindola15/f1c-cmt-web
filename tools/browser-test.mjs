// Prueba en Chromium real (Playwright): arranca el servidor de desarrollo, abre la página, espera cuadros y
// guarda capturas del lienzo. Uso: node tools/browser-test.mjs <carpeta del juego> <carpeta instantáneas> [segundos] [salida.png]
// Variables: CLICKS="x,y;x,y" (clics en coordenadas del juego tras la primera captura), PW=ruta a node_modules de playwright
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire((process.env.PW || process.env.HOME + '/pw') + '/package.json');
const { chromium } = require('playwright');
const [GAME, SNAP, SECS = '60', OUT = 'tests/shots/web.png'] = process.argv.slice(2); const PORT = 8150 + Math.floor(Math.random() * 500);
const srv = spawn('node', [new URL('./dev-server.mjs', import.meta.url).pathname, GAME, String(PORT), SNAP], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=4096'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 860 } });
page.on('console', (m) => console.log('[consola]', m.text()));
page.on('pageerror', (e) => console.log('[error]', e.message));
const t0 = Date.now(); const T = Number(SECS) * 1000;
await page.goto(`http://localhost:${PORT}/?snap=${process.env.SNAPNAME || "menu"}`);
let last = '';
const shot = async (name) => { if (process.env.PROBE) { await page.evaluate(() => window.f1c.worker.postMessage({ type: 'probe' })); await page.waitForFunction(() => window.f1c.probe, null, { timeout: 30000 }).catch(() => {}); console.log('[probe]', (await page.evaluate(() => window.f1c.probe) || '').slice(0, 1500)); }
  const url = await page.evaluate(async () => { window.f1c.shot = null; window.f1c.worker.postMessage({ type: 'shot' }); for (let i = 0; i < 100 && !window.f1c.shot; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.f1c.shot) return null; return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(window.f1c.shot); }); });
  if (url) { fs.writeFileSync(name.replace(/\.png$/, '-lienzo.png'), Buffer.from(url.split(',')[1], 'base64')); console.log('[captura lienzo]', name.replace(/\.png$/, '-lienzo.png')); } const s = await page.evaluate(() => window.f1c.lastStats); console.log(`[captura] ${name} t=${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(s)); await page.locator('#wrap').screenshot({ path: name }); };
while (Date.now() - t0 < T) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => ({ ready: window.f1c?.ready, halted: window.f1c?.halted, s: window.f1c?.lastStats, status: document.getElementById('status').textContent, logs: window.f1c?.logs.splice(0) || [] }));
  for (const l of st.logs) console.log('[log]', l);
  const line = st.ready ? `${st.s ? st.s.mips.toFixed(1) + ' MIPS ' + st.s.fps.toFixed(1) + ' fps draws=' + st.s.draws + ' instr=' + st.s.icount + ' omitidos=' + JSON.stringify(st.s.skipped) : 'sin stats'}` : st.status;
  if (line !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`); last = line; }
  if (st.halted) { console.log('[DETENIDO]', st.halted); break; }
  if (st.ready && st.s && st.s.draws > 0 && !globalThis.did) { globalThis.did = 1; globalThis.readyAt = Date.now(); }
  if (globalThis.readyAt && Date.now() - globalThis.readyAt > 6000 && !globalThis.shot1) { globalThis.shot1 = 1; await shot(OUT);
    for (const c of (process.env.CLICKS || '').split(';').filter(Boolean)) { const [x, y] = c.split(',').map(Number); const box = await page.locator('#screen').boundingBox();
      const px = box.x + x / 1024 * box.width, py = box.y + y / 768 * box.height; await page.mouse.move(px, py); await page.waitForTimeout(300); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up(); console.log('[clic]', x, y); await page.waitForTimeout(4000); }
    if (process.env.CLICKS) globalThis.after = Date.now(); }
  if (globalThis.after && Date.now() - globalThis.after > Number(process.env.AFTER || 15000) && !globalThis.shot2) { globalThis.shot2 = 1; await shot(OUT.replace(/\.png$/, '-despues.png')); break; }
}
if (!globalThis.shot1) await shot(OUT);
await browser.close(); srv.kill();
