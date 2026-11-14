// mss32.js — reemplazo de alto nivel de Miles Sound System (34 funciones que importa F1C).
// Por ahora registra y simula estados; el host (Chrome) recibe los samples para Web Audio en emu.audioHost.
import { api } from './common.js';
const SMP_DONE = 2, SMP_PLAYING = 4, SMP_STOPPED = 8;
const S = (e) => (e.mss ??= { samples: new Map(), seq: 0, streams: new Map(), prefs: new Map(), loaded: 0 });
function wavInfo(e, p) {
  const m = e.mem; if (m.r32(p) !== 0x46464952) return null; // 'RIFF'
  let o = p + 12; const end = p + 8 + m.r32(p + 4); const info = { format: 1, rate: 22050, bits: 16, channels: 1, data: 0, len: 0, block: 2 };
  while (o + 8 <= end) { const id = m.r32(o), sz = m.r32(o + 4);
    if (id === 0x20746d66) { info.format = m.r16(o + 8); info.channels = m.r16(o + 10); info.rate = m.r32(o + 12); info.block = m.r16(o + 20); info.bits = m.r16(o + 22); }
    else if (id === 0x61746164) { info.data = o + 8; info.len = sz; break; }
    o += 8 + sz + (sz & 1); }
  return info;
}
const A = (n, fn) => api(n, fn);
export const MSS32 = {
  '_AIL_startup@0': A(0, () => 1), '_AIL_shutdown@0': A(0, () => 0), '_AIL_serve@0': A(0, () => 0),
  '_AIL_set_preference@8': A(2, (e, k, v) => { const s = S(e); const old = s.prefs.get(k) ?? 0; s.prefs.set(k, v); return old; }),
  '_AIL_open_digital_driver@16': A(4, (e, freq, bits, ch, fl) => { e.log('MSS', `open_digital_driver ${freq} Hz ${bits} bits ${ch} canales`); S(e).dig = e.mem.alloc(256); return S(e).dig; }),
  '_AIL_set_DirectSound_HWND@8': A(2, () => 0), '_AIL_waveOutClose@4': A(1, () => 0),
  '_AIL_enumerate_filters@12': A(3, () => 0), '_AIL_open_filter@8': A(2, () => 0),
  '_AIL_set_sample_processor@12': A(3, () => 0), '_AIL_set_filter_sample_preference@12': A(3, () => 0),
  '_AIL_allocate_sample_handle@4': A(1, (e) => { const s = S(e); const h = e.mem.alloc(512); s.samples.set(h, { status: SMP_DONE, vol: [1, 1], rate: 22050, loops: 1, info: null }); return h; }),
  '_AIL_release_sample_handle@4': A(1, (e, h) => { S(e).samples.delete(h); e.audioHost?.stop?.(h); return 0; }),
  '_AIL_init_sample@4': A(1, (e, h) => { const x = S(e).samples.get(h); if (x) x.status = SMP_DONE; return 0; }),
  '_AIL_set_sample_file@12': A(3, (e, h, p, block) => { const x = S(e).samples.get(h); if (!x) return 0; x.info = wavInfo(e, p); if (x.info) x.rate = x.info.rate; S(e).loaded++; return x.info ? 1 : 0; }),
  '_AIL_set_sample_volume_levels@12': A(3, (e, h, l, r) => { const x = S(e).samples.get(h); const f = (v) => new Float32Array(new Uint32Array([v]).buffer)[0]; if (x) x.vol = [f(l), f(r)]; e.audioHost?.volume?.(h, x?.vol); return 0; }),
  '_AIL_set_sample_playback_rate@8': A(2, (e, h, r) => { const x = S(e).samples.get(h); if (x) x.rate = r; e.audioHost?.rate?.(h, r); return 0; }),
  '_AIL_set_sample_position@8': A(2, () => 0), '_AIL_set_sample_loop_count@8': A(2, (e, h, n) => { const x = S(e).samples.get(h); if (x) x.loops = n; return 0; }),
  '_AIL_start_sample@4': A(1, (e, h) => { const x = S(e).samples.get(h); if (x) { x.status = e.audioHost ? SMP_PLAYING : SMP_DONE; e.audioHost?.play?.(h, x); } return 0; }),
  '_AIL_stop_sample@4': A(1, (e, h) => { const x = S(e).samples.get(h); if (x) x.status = SMP_STOPPED; e.audioHost?.stop?.(h); return 0; }),
  '_AIL_resume_sample@4': A(1, (e, h) => { const x = S(e).samples.get(h); if (x && e.audioHost) { x.status = SMP_PLAYING; e.audioHost.play?.(h, x); } return 0; }),
  '_AIL_end_sample@4': A(1, (e, h) => { const x = S(e).samples.get(h); if (x) x.status = SMP_DONE; e.audioHost?.stop?.(h); return 0; }),
  '_AIL_sample_status@4': A(1, (e, h) => { const x = S(e).samples.get(h); if (!x) return SMP_DONE; if (x.status === SMP_PLAYING && e.audioHost?.isDone?.(h)) x.status = SMP_DONE; return x.status; }),
  '_AIL_WAV_info@8': A(2, (e, p, out) => { const i = wavInfo(e, p); if (!i) return 0; [i.format, i.data, i.len, i.rate, i.bits, i.channels, Math.floor(i.len / Math.max(1, i.block)), i.block, i.data].forEach((v, k) => e.mem.w32(out + 4 * k, v)); return 1; }),
  '_AIL_mem_free_lock@4': A(1, (e, p) => { if (p) e.mem.free?.(p); return 0; }),
  '_AIL_set_file_callbacks@16': A(4, (e, open, close, seek, read) => { S(e).cb = { open, close, seek, read }; e.log('MSS', `file callbacks open=0x${open.toString(16)}`); return 0; }),
  '_AIL_file_read@8': A(2, (e, pName, dest) => { const name = e.mem.cstr(pName); const cb = S(e).cb;
    if (cb && cb.open) { // callbacks del juego (leen de sus propios paquetes)
      const ph = e.mem.alloc(4); if (!e.callGuest(cb.open, [pName, ph])) { e.log('MSS', `file_read "${name}" -> el juego no lo abrió`); return 0; }
      const h = e.mem.r32(ph); const size = e.callGuest(cb.seek, [h, 0, 2]); e.callGuest(cb.seek, [h, 0, 0]);
      const p = dest || e.mem.alloc(size + 16); const got = e.callGuest(cb.read, [h, p, size]); e.callGuest(cb.close, [h]); S(e).files = (S(e).files || 0) + 1;
      if (got !== size) e.log('MSS', `file_read "${name}": leídos ${got}/${size}`); return p; }
    const f = e.vfs.find(name); if (!f) { e.log('MSS', `file_read "${name}" -> no existe`); return 0; }
    const p = dest || e.mem.alloc(f.data.length + 16); e.mem.writeBytes(p, f.data); return p; }),
  '_AIL_open_stream@12': A(3, (e, dig, pName, mem) => { const name = e.mem.cstr(pName); const s = S(e); const h = e.mem.alloc(256); s.streams.set(h, { name, status: SMP_DONE }); e.log('MSS', `open_stream "${name}"`); return h; }),
  '_AIL_close_stream@4': A(1, (e, h) => { S(e).streams.delete(h); return 0; }), '_AIL_start_stream@4': A(1, () => 0), '_AIL_pause_stream@8': A(2, () => 0),
  '_AIL_register_stream_callback@8': A(2, () => 0), '_AIL_set_stream_volume_levels@12': A(3, () => 0),
};
