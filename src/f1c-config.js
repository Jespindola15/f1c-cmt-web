// Adapta el Config.ini del jugador al dispositivo emulado (sin tocar el original): GUID del adaptador WebGL2,
// modo de video (índice de la lista de modos de d3d8.js: 4 = 1024x768) y modo ventana.
export const WEB_VIDEOGUID = 'D7B71EE2-249F-11CF-EC70-C9525CC2D635';
export function patchConfig(text, { mode = 4 } = {}) {
  const set = (k, v) => { const re = new RegExp(`^${k}=.*$`, 'mi'); text = re.test(text) ? text.replace(re, `${k}=${v}`) : text.replace(/\[COMPONENTS\]\r?\n/i, (m) => m + `${k}=${v}\r\n`); };
  set('VIDEOGUID', WEB_VIDEOGUID); set('VIDEODRIVER', 0); set('VIDEOMODE', mode); set('WINDOWEDMODE', 1); set('VSYNC', 0); set('FSAA', 0);
  return text;
}
