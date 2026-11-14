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

- **Usuarios autorizados (con Backblaze B2 configurado):** abren `https://TU-SITIO.netlify.app/?key=SU-CLAVE` una vez
  (la clave queda guardada en ese navegador) y el juego descarga lo necesario y arranca solo. Sin selector de carpeta,
  sin instalar nada. Las visitas siguientes arrancan desde la caché del navegador.
- **Sin contenido configurado:** cada jugador importa su propia instalación (*Elegir carpeta…* → copia única en el
  almacenamiento privado del navegador). `?import` / `?setup` fuerzan ese modo aunque haya B2.
- **Publicar en Netlify (desde GitHub):** `netlify.toml` ya configura todo: build `node tools/build-web.mjs`, carpeta
  `dist`, función `netlify/functions/content-token.mjs`, Node 20, encabezados COOP/COEP. Sin dependencias.
  `dist/` (≈400 KB) tiene sólo el emulador: **no incluye archivos de EA ni de CMT**.
- **Probar en la PC:** `npm run build` y `npm run serve` → http://localhost:8800/
- **Desarrollo local:** `node tools/dev-server.mjs "<carpeta del juego>" 8150 <carpeta instantáneas>` (`?snap=` para diagnóstico).

## Distribución automática: Netlify + Backblaze B2 (sin Cloudflare)

```
navegador ──(1) GET /api/content-token + clave──▶ Netlify Function ──▶ B2 API (clave restringida, sólo en Netlify)
   │            ◀── {base, token de descarga (sólo lectura, prefijo f1c/, vence en 6 h)}
   └──(2) GET https://f00x.backblazeb2.com/file/<bucket>/f1c/files/…?Authorization=<token>  (directo a B2, CORS, Range)
```

- **Netlify** sirve el sitio y una función mínima que valida la clave del usuario (`ACCESS_KEYS`) y pide a B2 un token
  de descarga con `b2_get_download_authorization`. Las claves de B2 nunca llegan al navegador; el token sólo sirve para
  leer el prefijo del contenido y vence solo. Los archivos del juego **no pasan por Netlify** (no gastan su ancho de banda).
- **B2** guarda el contenido en un bucket **privado**; sin token responde 401. La regla CORS permite sólo el dominio del
  sitio, sólo descargas por nombre y el encabezado `Range`.
- **Cliente** (`web/netcache.js`): manifiesto con ruta, tamaño, SHA-256 y grupo; primero el grupo `boot` (≈850 archivos,
  195 MB) en paralelo, el resto cuando el juego lo abre. Descargas por rangos de 8 MB **reanudables**: un archivo a medio
  bajar se retoma desde el último byte guardado, tanto tras un corte de red como al cerrar y reabrir la página. Cada
  archivo se verifica con SHA-256 antes de usarse. Caché OPFS por hash: la segunda visita no descarga nada y, si cambia
  el contenido, sólo bajan los archivos cuyo hash cambió. Si el token vence, se pide otro sin interrumpir el juego.

### Configuración (una vez; sólo con autorización para distribuir los archivos de EA/CMT)

1. **Backblaze:** crear la cuenta en backblaze.com (B2 Cloud Storage). Recomendado: cargar un medio de pago y poner
   topes en *Caps & Alerts* (p. ej. US$ 1/día) — ver costos abajo. En *Application Keys* copiar la **Master Application Key**
   (keyID + applicationKey): se usa sólo en tu PC para los pasos 2 y 3.
2. **Bucket y clave restringida** (PowerShell, en la carpeta del proyecto):
   ```
   $env:B2_KEY_ID="<keyID maestra>"; $env:B2_APP_KEY="<applicationKey maestra>"
   node tools/b2-setup.mjs f1c-cmt https://TU-SITIO.netlify.app
   ```
   Crea el bucket privado `f1c-cmt` con CORS para tu dominio y una clave **sólo lectura + tokens** para ese bucket/prefijo.
   Muestra `B2_KEY_ID` / `B2_APP_KEY` para Netlify (copiarlas: B2 no vuelve a mostrar la clave).
3. **Subir el contenido** desde tu instalación (no se modifica; reanudable, omite lo que ya está con el mismo SHA-256):
   ```
   node tools/make-content.mjs "D:\descargas2\CMT 2025 F1C (8th gear)\F1 Challenge 2025 CMT" contenido
   node tools/b2-upload.mjs "D:\descargas2\CMT 2025 F1C (8th gear)\F1 Challenge 2025 CMT" contenido\manifest.json f1c-cmt
   ```
4. **Netlify** → *Site configuration → Environment variables* (scope: Builds y Functions):
   `B2_KEY_ID`, `B2_APP_KEY` (las restringidas del paso 2), `B2_BUCKET=f1c-cmt`, `ACCESS_KEYS=clave1,clave2,…`
   (una por persona; generar con `node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"`).
   Borrar `CONTENT_BASE` si existía. Luego *Deploys → Trigger deploy → Clear cache and deploy site*.
   Opcionales: `TOKEN_SECONDS` (validez del token, 21600 por defecto), `B2_PREFIX` (`f1c/`), `ACCESS_OPEN=1` (sin clave).
5. **Verificar en producción:** `node tools/check-origin.mjs https://TU-SITIO.netlify.app <una clave> --boot`
   (COOP/COEP, `config.json`, función con y sin clave, bucket privado, CORS, Range, token falso, SHA-256 de los 850
   archivos de arranque).
6. Repartir `https://TU-SITIO.netlify.app/?key=<clave>`. Para revocar a alguien: quitar su clave de `ACCESS_KEYS` y
   redeployar (su token vigente deja de servir como mucho en `TOKEN_SECONDS`).

### Límites y costos (consultados el 14/11/2026)

| | Qué consume este sitio | Costo |
|---|---|---|
| **B2 almacenamiento** | 3,72 GB de contenido | Primeros 10 GB gratis → **US$ 0**. Después US$ 6,95/TB/mes |
| **B2 descargas, con medio de pago** | ≈195 MB por usuario nuevo para arrancar + lo que abra (≈0,3–1 GB por circuito/autos) | Gratis hasta 3× lo almacenado (≈11 GB/mes); luego US$ 0,01/GB → 100 usuarios nuevos × 1 GB ≈ **US$ 0,90/mes** |
| **B2 sin medio de pago** | idem | 1 GB/día de descarga y 2.500 descargas (clase B)/día gratis; al superar el tope **se corta** → ≈2 arranques en frío por día. Sirve para probar, no para varios usuarios |
| **B2 llamadas a la API** | 1 token cada ~3 h por instancia activa de la función | Clases A, B y C sin costo para cuentas con pago |
| **Netlify Free** | sitio ≈0,4 MB por visita nueva, ≈45 pedidos, 1 llamada a la función | 300 créditos/mes con tope duro: 20 créditos/GB, 2 créditos/10.000 pedidos, 10 créditos/GB-hora de función, **15 créditos por deploy de producción**. 1.000 visitas ≈ 20 créditos; el límite real son ~15–20 deploys/mes |
| **Netlify Personal / Pro** | — | US$ 9 (1.000 créditos) / US$ 20 (3.000 créditos) por mes, si hiciera falta |

Los archivos del juego van de B2 al navegador sin pasar por Netlify, así que el gasto de Netlify no crece con el tamaño
del juego. Una URL de bucket **público** (`CONTENT_BASE=https://f00x.backblazeb2.com/file/<bucket>/f1c/`) también funciona
y es aún más simple, pero deja los archivos descargables por cualquiera: no se recomienda para contenido comercial.

### Pruebas realizadas (14/11/2026, sin cuentas reales: B2 simulado con `tools/b2-local.mjs` + la función real)

`tools/b2-local.mjs` imita la API nativa de B2 (bucket privado, tokens de descarga por prefijo, CORS, Range, subida).
La función que se probó es el mismo archivo que despliega Netlify. Chromium con perfil vacío, `tools/net-test.mjs` con `B2=1`:

| Prueba | Resultado |
|---|---|
| Herramientas: `b2-setup` → `b2-upload` (61 archivos) → `b2-upload` otra vez → `check-origin --boot` | bucket privado + CORS + clave restringida; 61 subidos; 2ª vez 0 subidos; 13/13 verificaciones OK; clave mala → 401 |
| Sin clave | "Acceso restringido", B2 no entregó ningún archivo |
| Con `?key=`, página cerrada a los 4 s | 91 de 195 MB bajados |
| Reabrir sin `?key`, con cortes de conexión simulados (1 de cada 3 respuestas grandes) | retomó 8 MB a medias, bajó sólo los 179 archivos faltantes, superó 5 cortes, hashes OK, juego arrancado |
| Todo "a demanda" (descargas síncronas mientras corre el juego), cortes 1 de cada 4 | 563 archivos bajados mientras el juego los abría (incluido uno de 8,4 MB en 2 rangos), 3 cortes superados, sin errores |
| Segunda visita | sólo el manifiesto; 0 archivos del juego; arranque directo |

Ninguna corrida mostró el selector de carpeta. **No se probó todavía contra Backblaze y Netlify reales** (no hay acceso a las cuentas).


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
