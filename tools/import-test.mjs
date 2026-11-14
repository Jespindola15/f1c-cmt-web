// Prueba de la versión publicada (dist/): importación de la carpeta del juego por <input webkitdirectory> a OPFS
// y arranque desde la copia importada. Perfil persistente para conservar OPFS entre ejecuciones.
//   node tools/import-test.mjs <carpeta del juego> <import|play> [segundos] [salida.png]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire((process.env.PW || process.env.HOME + '/pw') + '/package.json');
const { chromium } = require('playwright');
const [GAME, MODE = 'import', SECS = '160', OUT = 'tests/shots/dist.png'] = process.argv.slice(2); const PORT = 8800 + Math.floor(Math.random() * 100);
const srv = spawn('node', [new URL('./static-server.mjs', import.meta.url).pathname, 'dist', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const ctx = await chromium.launchPersistentContext(process.env.HOME + '/chrome-profile', { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], viewport: { width: 1100, height: 950 } });
const page = await ctx.newPage(); const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
page.on('pageerror', (e) => console.log('[error]', e.message));
page.on('console', (m) => { const t = m.text(); if (!t.includes('[FS]')) console.log('[consola]', t.slice(0, 200)); });
await page.goto(`http://localhost:${PORT}/?picker=input${MODE === 'import' ? '&setup' : ''}`);
console.log(T(), 'aislamiento entre orígenes:', await page.evaluate(() => self.crossOriginIsolated));
if (MODE === 'import') {
  await page.waitForSelector('#dirinput', { state: 'attached', timeout: 20000 });
  await page.setInputFiles('#dirinput', GAME, { timeout: 150000 }); console.log(T(), 'carpeta entregada');
}
let last = '';
while (Date.now() - t0 < Number(SECS) * 1000) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({ t: document.getElementById('ptitle').textContent, p: document.getElementById('ptext').textContent, hidden: document.getElementById('panel').hidden, s: document.getElementById('stats').textContent, logs: window.f1c.logs.splice(0) }));
  for (const l of st.logs) if (!l.startsWith('[PE]') && !l.startsWith('[IMPORT] ')) console.log('[log]', l.slice(0, 200));
  const line = `${st.t} | ${st.p} | ${st.hidden ? 'JUEGO VISIBLE ' + st.s : ''}`; if (line !== last) { console.log(T(), line); last = line; }
  if (MODE === 'import' && st.t.startsWith('Arrancando')) { console.log(T(), 'importación terminada'); break; }
  if (st.t.includes('detuvo') || st.t.includes('No se pudo')) break;
}
if (MODE === 'play') await page.locator('#wrap').screenshot({ path: OUT });
await ctx.close(); srv.kill();
