// Compila tools/wasm/accel.wat -> src/wasm-accel.js (bytes en base64). Requiere el paquete npm "wabt".
//   NODE_PATH=<carpeta con node_modules/wabt> node tools/wasm/build.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.WABT || import.meta.url);
const wabt = await require('wabt')();
const src = fs.readFileSync(new URL('./accel.wat', import.meta.url), 'utf8');
const mod = wabt.parseWat('accel.wat', src, { simd: true }); mod.validate();
const { buffer } = mod.toBinary({});
fs.writeFileSync(new URL('../../src/wasm-accel.js', import.meta.url), `// Generado por tools/wasm/build.mjs desde tools/wasm/accel.wat (no editar a mano)\nexport const WASM_ACCEL_B64 = '${Buffer.from(buffer).toString('base64')}';\n`);
console.log('wasm', buffer.length, 'bytes');
