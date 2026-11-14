// Prueba del flujo automático: sitio (dist/) + origen de contenido en otro puerto; mide descargas reales y arranque.
//   node tools/net-test.mjs <carpeta manifiesto> <carpeta juego> [segundos] [salida.png]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire((process.env.PW || process.env.HOME + '/pw') + '/package.json');
const { chromium } = require('playwright');
const [MAN, GAME, SECS = '160', OUT = 'tests/shots/net.png'] = process.argv.slice(2);
// B2=1: Backblaze B2 privado simulado (tools/b2-local.mjs, espejo de la instalación) + la función real de Netlify
// (/api/content-token) servida por static-server; el sitio debe estar compilado con B2_BUCKET (config.json contentToken).
const B2 = process.env.B2; const tool = (n) => new URL(n, import.meta.url).pathname;
const content = B2 ? spawn('node', [tool('./b2-local.mjs'), '8902', '--mirror', MAN, GAME], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, B2_KEY_ID: 'test', B2_APP_KEY: 'test', ALLOWED_ORIGINS: 'http://localhost:8812' } })
  : spawn('node', [tool('./content-server.mjs'), MAN, GAME, '8900'], { stdio: ['ignore', 'pipe', 'inherit'] });
const site = spawn('node', [tool('./static-server.mjs'), 'dist', '8812'], { stdio: ['ignore', 'pipe', 'inherit'], env: B2 ? { ...process.env, B2_API_URL: 'http://localhost:8902', B2_KEY_ID: 'test', B2_APP_KEY: 'test', B2_BUCKET: 'f1c-cmt', ACCESS_KEYS: process.env.ACCESS_KEYS || 'clave-prueba' } : process.env });
await Promise.all([new Promise((r) => content.stdout.once('data', r)), new Promise((r) => site.stdout.once('data', r))]);
content.stdout.on('data', (d) => process.stdout.write(d));
const ctx = await chromium.launchPersistentContext(process.env.HOME + (process.env.PROFILE || '/chrome-profile-net'), { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], viewport: { width: 1100, height: 950 } });
const page = await ctx.newPage(); const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
page.on('pageerror', (e) => console.log('[error]', e.message));
await page.goto(process.env.URL || (B2 ? 'http://localhost:8812/' : `http://localhost:8812/?content=http://localhost:8900/`));
let last = '';
while (Date.now() - t0 < Number(SECS) * 1000) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => ({ t: document.getElementById('ptitle').textContent, p: document.getElementById('ptext').textContent, hidden: document.getElementById('panel').hidden, s: document.getElementById('stats').textContent, n: document.getElementById('net').textContent, logs: window.f1c.logs.splice(0) }));
  for (const l of st.logs) if (/^\[(NET|VFS|MSGBOX|HALT)/.test(l) || l.includes('DETENIDO')) console.log('[log]', l.slice(0, 220));
  const line = st.hidden ? `JUEGO VISIBLE ${st.s} ${st.n}` : `${st.t} | ${st.p}`; if (line !== last) { console.log(T(), line); last = line; }
  if (st.t.includes('detuvo') || (st.t.includes('Acceso restringido') && process.env.STOP_AUTH)) break;
}
await page.locator('#wrap').screenshot({ path: OUT }); await ctx.close(); content.kill('SIGTERM'); site.kill();
await new Promise((r) => setTimeout(r, 300));
