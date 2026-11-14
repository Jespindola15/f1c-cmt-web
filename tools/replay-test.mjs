// Reproduce un cuadro capturado en Chromium y guarda una captura PNG del lienzo.
//   CAP=<dir capturas> node tools/replay-test.mjs <nombre> <salida.png> [upto]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire((process.env.PW || process.env.HOME + '/pw') + '/package.json');
const { chromium } = require('playwright');
const [NAME, OUT, UPTO] = process.argv.slice(2); const PORT = 8700 + Math.floor(Math.random() * 200);
const srv = spawn('node', [new URL('./dev-server.mjs', import.meta.url).pathname, '/tmp', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
await new Promise((r) => srv.stdout.once('data', r));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('console', (m) => console.log('[consola]', m.text())); page.on('pageerror', (e) => console.log('[error]', e.message));
await page.goto(`http://localhost:${PORT}/web/replay.html?cap=${NAME}${UPTO ? '&upto=' + UPTO : ''}`);
await page.waitForFunction(() => window.replayDone, null, { timeout: 120000 }).catch((e) => console.log('timeout', e.message));
console.log(await page.textContent('#s'));
await page.locator('#c').screenshot({ path: OUT }); await browser.close(); srv.kill();
