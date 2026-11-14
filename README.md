# F1 Challenge CMT 2025 Web

Ejecutar la instalación **F1 Challenge CMT 2025** (motor ISI original + parches CMT) dentro de Chrome,
sin streaming ni recreaciones: el `F1C_CMT.exe` real corre sobre un emulador x86 en JavaScript con las APIs
de Windows reimplementadas para el navegador.

Base: núcleo de **Daytona USA Web** (intérprete + JIT x86, cargador PE, Win32 en JS), copiado y extendido.

## Estado (13/11/2026)

| Prueba | Resultado |
|---|---|
| `tests/simd`: MMX + SSE + SSE2 contra Unicorn (2.904 + 8.712 casos, 4 modos de redondeo) | **100 % idénticos** |
| `tools/run-f1c.mjs`: exe real con tus archivos | Llega a `IDirect3D8::CreateDevice` (412,95 M instrucciones, ~10 s, ~41 MIPS en Node) |
| Flags de `CreateDevice` | `0x80` MIXED_VERTEXPROCESSING, sin FPU_PRESERVE (igual que en Unicorn) |

Todavía **no** corre en Chrome ni dibuja: falta el dispositivo Direct3D 8 → WebGL2.

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
