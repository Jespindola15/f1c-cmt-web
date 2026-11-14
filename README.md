# F1 Challenge CMT 2025 Web

Ejecutar la instalación **F1 Challenge CMT 2025** (motor ISI original + parches CMT) dentro de Chrome,
sin streaming ni recreaciones: el `F1C_CMT.exe` real corre sobre un emulador x86 en JavaScript con las APIs
de Windows reimplementadas para el navegador.

Base: núcleo de **Daytona USA Web** (intérprete + JIT x86, cargador PE, Win32 en JS), copiado y extendido.

## Estado (14/11/2026)

**Funciona, verificado con pruebas reales** (instalación CMT 2025 intacta, sin instantáneas en el producto):

| Qué | Cómo se comprobó |
|---|---|
| Arranque desde `F1C_CMT.exe` en Chrome hasta la pantalla legal de CMT | `dist/` servido estático con COOP/COEP (`crossOriginIsolated=true`), Chromium 141 |
| Importación única de la instalación a OPFS (3.738 archivos, 3,72 GB) y arranque desde esa copia | `tools/import-test.mjs` (import + play con perfil persistente) |
| Menú → *Test day* → Albert Park (0 IA) → carga de la pista, generación del `.HAT`, autos, sonidos → monitor de sesión → *Drive* → auto en pista | `tools/nav.mjs` (clics reales del juego), capturas de la interfaz |
| Cuadro real de carrera dibujado por el backend WebGL2 (cockpit, pista, tribunas, HUD, render-to-texture) | `tools/frame-capture.mjs` + `web/replay.html` → `tests/shots/replay_r9.png` |
| Conducción: con la tecla de acelerar (A) el auto se mueve por la física original | `tools/nav.mjs "10:key:30,65"` + captura (`replay_r10.png`) |
| JIT idéntico al intérprete (registros, FPU, MMX/XMM y hash de toda la memoria) | `tests/jit_equiv.mjs` en menú (1.200 M instr.), carga (600 M) y carrera (300 M) |

**Bloqueos de la carrera encontrados y corregidos:** asignador del heap sin fusión de bloques (se agotaba al cargar la
pista); 1 GB de superficies Direct3D nunca liberadas (`Release` no liberaba); espacio de direcciones de 1 GiB
(ahora 2 GiB = espacio de usuario Win32); MMX `pmaddwd`/`psrlq` e instrucciones de cadena por el intérprete (carga
de texturas 10× más lenta); `rep movs` solapado; render-to-texture en WebGL2; instantáneas que no entraban en RAM.

### Mediciones (i5-13420H, un núcleo; Node 22 / Chromium 141)

| | cuadros/s | MIPS | instr. x86 por cuadro |
|---|---|---|---|
| Menú principal (auto 3D girando), Chrome sólo emulación | 52,5 | ~1.000 | 19,6 M |
| Carrera, Albert Park cockpit (Node) | 14–16 | ~300 | 19,5 M |
| Carga menú → pista (primera vez, incluye generar el `.HAT`) | — | 200–600 | ~300.000 M (≈ 8–10 min) |

Distribución de la carrera por instrucciones: iluminación/reflejos por vértice de los autos en software
(0x55E000 + transformaciones) **49 %**; 0x44A000 9,5 %; 0x56B000 5,9 %; el resto repartido (física, IA, cámara,
sonido sin separar todavía por falta de símbolos). La parte Direct3D/WebGL en CPU es <2 %.
RAM: heap emulado en carrera 1,36 GB (de 2 GiB de espacio Win32); el navegador además guarda las texturas en la GPU.
En carrera el rendimiento **todavía no alcanza** 40–60 FPS: hace falta ~3× (ver "Qué falta").

### Qué falta (en orden)

1. **Rendimiento en carrera**: JIT con backend WebAssembly (la memoria emulada ya es `WebAssembly.Memory`), o la
   rutina de iluminación por vértice (49 % de la carrera) en código nativo verificado; menos despachos por llamadas
   indirectas.
2. **Tiempo de carga** de la pista (código frío: compilación del JIT + D3DX): cachear el `.HAT` ya funciona (OPFS).
3. **Sonido** (Miles → Web Audio): hoy los samples se registran pero no suenan.
4. `oph.dll`, LightLoader/Lua y plugins del mod, hilos, Bink, red (salas) — siguen pendientes.
5. Probar la carrera completa en Chrome con GPU real (la VM de pruebas no tiene RAM para Chrome + 2 GiB de memoria emulada).

## Jugar / publicar

- **Jugadores:** entrar a la URL, *Elegir carpeta…* (la carpeta "F1 Challenge 2025 CMT"), esperar la copia (una sola
  vez, ~3,7 GB en el almacenamiento privado del navegador) y el juego arranca solo. Las próximas veces arranca directo.
  `?setup` vuelve a mostrar la importación. Nada se sube a ningún servidor y la instalación no se modifica.
- **Publicar en Cloudflare Pages:** `node tools/build-web.mjs` → `npx wrangler pages deploy dist --project-name f1c-cmt-web`.
  `dist/` (≈390 KB) tiene sólo el emulador y `_headers` con COOP/COEP; **no incluye archivos de EA ni de CMT**.
  Si el operador tuviera autorización para distribuir los archivos, `CONTENT_BASE=https://…/ node tools/build-web.mjs`
  agrega `config.json` y el juego los descarga bajo demanda (p.ej. desde R2) en lugar de importarlos.
- **Desarrollo local:** `node tools/dev-server.mjs "<carpeta del juego>" 8150 <carpeta instantáneas>` (`?snap=` para diagnóstico).

## Cambios respecto del núcleo de Daytona

- `src/simd.js` (nuevo): MMX, SSE, SSE2 completos para lo que usan el exe y las DLLs del mod; MXCSR con los 4 modos de redondeo exactos, NaN y ceros con signo como x86.
- `src/cpu.js`: despacho SIMD; `cpuid` = CPU moderna con MMX/SSE/SSE2, sin 3DNow!/SSE3+/AVX.
- `src/emulator.js`: las secciones PE se copian enteras (`SizeOfRawData`), como Windows: el parche CMT vive pasado el `VirtualSize` de `.text`.
- `src/win32/f1c.js` (nuevo): VFS sobre disco con carpetas y directorio actual (solo lectura; escrituras en memoria), ~60 APIs que F1C usa, `IDirect3D8` mínimo, `IsProcessorFeaturePresent`.

## Rendimiento (14/11/2026) — menú principal con el auto 3D, misma PC (i5-13420H)

| Paso | Node (cuadros/s) | Chrome, sólo emulación |
|---|---|---|
| Inicio (JIT por bloques) | 4,8 | 3 |
| Memoria con vistas tipadas + MMX en el JIT | 8,3 | |
| Accesos a memoria y pila x87 en línea | 23 | |
| Regiones (switch sobre EIP), flags entre bloques, registros en locales | 31 | 38,6 |
| Pila x87 en locales, despacho por índice denso | 45 | 47,5 |
| Memoria en WebAssembly.Memory + blit con color clave en WASM SIMD | 49 | 50 |
| Máscara única de alineación/límite; sólo registros usados | 52 | 52,5 |

Cada cuadro del menú cuesta ~19,6 M instrucciones x86 (iluminación por vértice del auto en software + composición
de la interfaz). Verificación: `tests/jit_equiv.mjs` (JIT optimizado vs intérprete: registros, FPU, MMX/XMM y hash de
toda la memoria idénticos tras 1.200 M instrucciones en el menú y 600 M en la carga), `tests/accel/accel_test.mjs`
(aceleradores vs rutina original) y `tests/simd/mmx_jit.mjs`. Medir: `node tools/bench-snap.mjs <juego> snap/menu-principal`;
en Chrome, `?nodraw=1` mide sólo la emulación y la barra superior muestra ms de emulación y de gráficos por cuadro.

## Uso

```bash
node tools/run-f1c.mjs "<carpeta de F1 Challenge 2025 CMT>"     # arranque hasta CreateDevice
node tests/simd/run_cases.mjs                                    # pruebas SIMD (requiere cases.json)
python3 tests/simd/gen_cases.py                                  # regenera casos con Unicorn + Keystone
```

Requiere un `Config.ini` con `VIDEOMODE` válido para la lista de modos emulada (la versión web generará el suyo).
La instalación original nunca se modifica.
