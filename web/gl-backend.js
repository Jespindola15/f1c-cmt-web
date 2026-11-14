// gl-backend.js — traduce las llamadas de dibujo de Direct3D 8 (d3d8.js) a WebGL2.
// Cubre: FVF (XYZ / XYZRHW, normal, diffuse, specular, 0-8 texcoords), primitivas, buffers de vértices/índices y
// datos "UP", 2 etapas de textura (operaciones comunes), alpha test, blending, z, culling, clear, texturas
// A8R8G8B8 / X8R8G8B8 / R5G6B5 / A1R5G5B5 / A4R4G4B4 / DXT1-5 / L8 / A8. Iluminación fija y niebla: pendientes.
const RS = { ZENABLE: 7, ZWRITEENABLE: 14, ALPHATESTENABLE: 15, SRCBLEND: 19, DESTBLEND: 20, CULLMODE: 22, ZFUNC: 23, ALPHAREF: 24, ALPHAFUNC: 25, ALPHABLENDENABLE: 27, TEXTUREFACTOR: 60 };
const TSS = { COLOROP: 1, COLORARG1: 2, COLORARG2: 3, ALPHAOP: 4, ALPHAARG1: 5, ALPHAARG2: 6, TEXCOORDINDEX: 11, ADDRESSU: 13, ADDRESSV: 14, MAGFILTER: 16, MINFILTER: 17, MIPFILTER: 18 };
const VS = `#version 300 es
layout(location=0) in vec4 aPos; layout(location=1) in vec4 aDiff; layout(location=2) in vec4 aSpec;
layout(location=3) in vec2 aT0; layout(location=4) in vec2 aT1;
uniform bool uRHW; uniform vec4 uScreen; uniform mat4 uWVP; uniform bool uHasDiff;
out vec4 vDiff; out vec4 vSpec; out vec2 vT0; out vec2 vT1;
void main() {
  if (uRHW) { float w = aPos.w > 0.0 ? 1.0 / aPos.w : 1.0;
    vec2 ndc = vec2((aPos.x + 0.5) / uScreen.x * 2.0 - 1.0, 1.0 - (aPos.y + 0.5) / uScreen.y * 2.0);
    gl_Position = vec4(ndc * w, (aPos.z * 2.0 - 1.0) * w, w);
  } else { vec4 p = uWVP * vec4(aPos.xyz, 1.0); gl_Position = vec4(p.x, p.y, p.z * 2.0 - p.w, p.w); }
  vDiff = uHasDiff ? aDiff.bgra : vec4(1.0); vSpec = aSpec.bgra; vT0 = aT0; vT1 = aT1;
}`;
const FS = `#version 300 es
precision highp float;
in vec4 vDiff; in vec4 vSpec; in vec2 vT0; in vec2 vT1;
uniform sampler2D uTex0; uniform sampler2D uTex1; uniform bool uHas0; uniform bool uHas1; uniform ivec2 uSw;
vec4 swz(vec4 t, int k) { return k == 1 ? t.bgra : k == 2 ? vec4(t.bgr, 1.0) : t; }
uniform ivec3 uC0; uniform ivec3 uA0; uniform ivec3 uC1; uniform ivec3 uA1; uniform vec4 uTF;
uniform int uAlphaFunc; uniform float uAlphaRef; uniform bool uAlphaTest;
out vec4 o;
vec4 arg(int a, vec4 cur, vec4 tex) { int k = a & 15; vec4 v = k == 0 ? vDiff : k == 1 ? cur : k == 2 ? tex : k == 3 ? uTF : k == 4 ? vSpec : cur;
  if ((a & 16) != 0) v = 1.0 - v; if ((a & 32) != 0) v = vec4(v.a); return v; }
vec4 op(int o, vec4 a1, vec4 a2, vec4 cur) {
  if (o == 2) return a1; if (o == 3) return a2; if (o == 4) return a1 * a2; if (o == 5) return clamp(a1 * a2 * 2.0, 0.0, 1.0);
  if (o == 6) return clamp(a1 * a2 * 4.0, 0.0, 1.0); if (o == 7) return clamp(a1 + a2, 0.0, 1.0); if (o == 8) return clamp(a1 + a2 - 0.5, 0.0, 1.0);
  if (o == 10) return clamp(a1 - a2, 0.0, 1.0); if (o == 13) return mix(a2, a1, vDiff.a); if (o == 12) return mix(a2, a1, cur.a);
  if (o == 24) { float d = clamp(dot(a1.rgb - 0.5, a2.rgb - 0.5) * 4.0, 0.0, 1.0); return vec4(d); }
  return a1 * a2; }
vec4 stage(ivec3 C, ivec3 A, vec4 cur, vec4 tex) {
  vec4 col = op(C.x, arg(C.y, cur, tex), arg(C.z, cur, tex), cur); vec4 al = A.x == 1 ? cur : op(A.x, arg(A.y, cur, tex), arg(A.z, cur, tex), cur);
  return vec4(col.rgb, al.a); }
bool cmp(int f, float a, float b) { return f == 1 ? false : f == 2 ? a < b : f == 3 ? a == b : f == 4 ? a <= b : f == 5 ? a > b : f == 6 ? a != b : f == 7 ? a >= b : true; }
void main() {
  vec4 cur = vDiff;
  if (uC0.x != 1) { vec4 t = uHas0 ? swz(texture(uTex0, vT0), uSw.x) : vec4(1.0); cur = stage(uC0, uA0, cur, t);
    if (uC1.x != 1) { vec4 t1 = uHas1 ? swz(texture(uTex1, vT1), uSw.y) : vec4(1.0); cur = stage(uC1, uA1, cur, t1); } }
  cur.rgb = clamp(cur.rgb + vSpec.rgb * 0.0, 0.0, 1.0);
  if (uAlphaTest && !cmp(uAlphaFunc, floor(cur.a * 255.0 + 0.5), uAlphaRef)) discard;
  o = cur; }`;
export class GLBackend {
  constructor(canvas, emu) {
    this.canvas = canvas; this.emu = emu;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, depth: true, stencil: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 no disponible');
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = this.prog = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p); this.u = {}; for (const n of ['uRHW', 'uScreen', 'uWVP', 'uHasDiff', 'uTex0', 'uTex1', 'uHas0', 'uHas1', 'uC0', 'uA0', 'uC1', 'uA1', 'uTF', 'uAlphaFunc', 'uAlphaRef', 'uAlphaTest', 'uSw']) this.u[n] = gl.getUniformLocation(p, n);
    gl.uniform1i(this.u.uTex0, 0); gl.uniform1i(this.u.uTex1, 1);
    this.vbo = gl.createBuffer(); this.ibo = gl.createBuffer(); this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.texCache = new Map(); this.rtFbo = new Map(); this.stats = { draws: 0, tris: 0, texUploads: 0, frames: 0, skipped: {} };
    this.white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.white); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }
  // El juego dibuja en un framebuffer propio (el "back buffer"); Present lo copia al lienzo. Así el navegador
  // nunca muestra un cuadro a medio dibujar aunque el worker ceda el control en mitad del cuadro.
  size(w, h) {
    const gl = this.gl; if (this.fbW === w && this.fbH === h) return;
    this.fbW = w; this.fbH = h; if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteRenderbuffer(this.rbC); gl.deleteRenderbuffer(this.rbZ); }
    this.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.rbC = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbC); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    this.rbZ = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbZ); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.rbC);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.rbZ); this.cur = this.fbo;
  }
  clear(dev, fl, color, z, stencil) {
    if (this.noDraw) return;
    const gl = this.gl; const [, TH] = this.bindTarget(dev);
    const v = dev.viewport; gl.enable(gl.SCISSOR_TEST); gl.scissor(v[0], TH - v[1] - v[3], v[2], v[3]); let bits = 0;
    if (fl & 1) { gl.clearColor(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, ((color >>> 24) & 255) / 255); bits |= gl.COLOR_BUFFER_BIT; }
    if (fl & 2) { gl.depthMask(true); gl.clearDepth(z); bits |= gl.DEPTH_BUFFER_BIT; }
    if (fl & 4) { gl.clearStencil(stencil); bits |= gl.STENCIL_BUFFER_BIT; }
    gl.colorMask(true, true, true, true); if (bits) gl.clear(bits); gl.disable(gl.SCISSOR_TEST);
  }
  released(o) { const t = this.texCache.get(o); if (t) { this.gl.deleteTexture(t); this.texCache.delete(o); } }
  // Destino de dibujo: back buffer (FBO propio) o un nivel de textura (render-to-texture: espejos, reflejos).
  bindTarget(dev) {
    const gl = this.gl, rt = dev.rt, bb = dev.backbuffer;
    if (!rt || rt === bb || rt.kind === 'backbuffer') { this.size(bb.w, bb.h); if (this.cur !== this.fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); this.cur = this.fbo; } return [bb.w, bb.h]; }
    let f = this.rtFbo.get(rt);
    if (!f) {
      f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      if (rt.container) { const t = this.textureObj(rt.container); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, rt.level || 0); rt.container.gpu = true; t.swz = 0; }
      else { const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, rt.w, rt.h); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb); }
      const zb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, zb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, rt.w, rt.h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, zb);
      this.rtFbo.set(rt, f); this.cur = f;
    }
    if (this.cur !== f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); this.cur = f; }
    return [rt.w, rt.h];
  }
  present(dev) { const T0 = performance.now(); if (this.noDraw) this.stats.frames++; else this.present_(dev); if (this.timing) this.gl.finish(); this.stats.presentMs = (this.stats.presentMs || 0) + performance.now() - T0; }
  present_(dev) {
    const gl = this.gl; this.size(dev.backbuffer.w, dev.backbuffer.h); this.stats.frames++;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST); gl.blitFramebuffer(0, 0, this.fbW, this.fbH, 0, 0, this.fbW, this.fbH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); this.cur = this.fbo;
  }
  texture(id) {
    const o = this.emu.d3d.objs.get(id); if (!o || o.kind !== 'texture') return null;
    return this.textureObj(o);
  }
  textureObj(o) {
    let t = this.texCache.get(o); const gl = this.gl;
    if (!t) { t = gl.createTexture(); this.texCache.set(o, t); o.dirty = true; }
    if (o.dirty) { this.upload(t, o); o.dirty = false; this.stats.texUploads++; }
    return t;
  }
  upload(t, o) {
    const gl = this.gl, m = this.emu.mem.u8; gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    o.surfaces.forEach((s, lv) => {
      const src = m.subarray(s.mem, s.mem + s.size); const f = s.fmt;
      if (f === 21 || f === 22) { // BGRA en memoria: se sube tal cual y el shader reordena (sin copia en JS)
        t.swz = f === 22 ? 2 : 1;
        if (t.alloc?.[lv] === s.w + 'x' + s.h) gl.texSubImage2D(gl.TEXTURE_2D, lv, 0, 0, s.w, s.h, gl.RGBA, gl.UNSIGNED_BYTE, src);
        else { gl.texImage2D(gl.TEXTURE_2D, lv, gl.RGBA8, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src); (t.alloc ??= [])[lv] = s.w + 'x' + s.h; } }
      else if (f === 20) { const n = s.w * s.h; const out = new Uint8Array(n * 4); for (let i = 0; i < n; i++) { out[i * 4] = src[i * 3 + 2]; out[i * 4 + 1] = src[i * 3 + 1]; out[i * 4 + 2] = src[i * 3]; out[i * 4 + 3] = 255; }
        gl.texImage2D(gl.TEXTURE_2D, lv, gl.RGBA8, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, out); }
      else if (f === 23) gl.texImage2D(gl.TEXTURE_2D, lv, gl.RGB565, s.w, s.h, 0, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, new Uint16Array(src.buffer, src.byteOffset, s.w * s.h).slice());
      else if (f === 24 || f === 25 || f === 26) { const n = s.w * s.h; const out = new Uint16Array(n); const v = new Uint16Array(src.slice().buffer, 0, n);
        for (let i = 0; i < n; i++) { const x = v[i]; out[i] = f === 26 ? (((x << 4) & 0xfff0) | (x >> 12)) : (((x << 1) & 0xfffe) | (f === 24 ? 1 : (x >> 15))); }
        gl.texImage2D(gl.TEXTURE_2D, lv, f === 26 ? gl.RGBA4 : gl.RGB5_A1, s.w, s.h, 0, gl.RGBA, f === 26 ? gl.UNSIGNED_SHORT_4_4_4_4 : gl.UNSIGNED_SHORT_5_5_5_1, out); }
      else if (f >= 0x31545844 && f <= 0x35545844 && this.s3tc) { const fm = f === 0x31545844 ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT : f <= 0x33545844 ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT : this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT;
        gl.compressedTexImage2D(gl.TEXTURE_2D, lv, fm, s.w, s.h, 0, src.slice()); }
      else if (f === 50 || f === 28) { const n = s.w * s.h; const out = new Uint8Array(n * 4); for (let i = 0; i < n; i++) { const v = src[i]; out[i * 4] = f === 50 ? v : 255; out[i * 4 + 1] = f === 50 ? v : 255; out[i * 4 + 2] = f === 50 ? v : 255; out[i * 4 + 3] = f === 50 ? 255 : v; } gl.texImage2D(gl.TEXTURE_2D, lv, gl.RGBA8, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, out); }
      else { this.stats.skipped['fmt' + f] = (this.stats.skipped['fmt' + f] || 0) + 1; }
    });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, o.surfaces.length - 1);
  }
  sampler(dev, st) {
    const gl = this.gl, ts = dev.tss[st]; const wrap = (v) => v === 3 ? gl.CLAMP_TO_EDGE : v === 2 ? gl.MIRRORED_REPEAT : v === 4 ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(ts.get(TSS.ADDRESSU) ?? 1)); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(ts.get(TSS.ADDRESSV) ?? 1));
    const mag = ts.get(TSS.MAGFILTER) ?? 1, min = ts.get(TSS.MINFILTER) ?? 1, mip = ts.get(TSS.MIPFILTER) ?? 0;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag === 1 ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip === 0 ? (min === 1 ? gl.NEAREST : gl.LINEAR) : mip === 1 ? (min === 1 ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_NEAREST) : (min === 1 ? gl.NEAREST_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_LINEAR));
  }
  draw(dev, kind, a) { if (this.noDraw) { this.stats.draws++; return; } const T0 = performance.now(); try { return this.draw_(dev, kind, a); } finally { if (this.timing) this.gl.finish(); this.stats.drawMs = (this.stats.drawMs || 0) + performance.now() - T0; } }
  draw_(dev, kind, a) {
    const gl = this.gl, e = this.emu, m = e.mem.u8; const [TW, TH] = this.bindTarget(dev);
    if (dev.vs >= 0x10000) { this.stats.skipped.vshader = (this.stats.skipped.vshader || 0) + 1; return; } // vertex shaders: pendiente
    const fvf = dev.vs; const L = layout(fvf); if (!L) { this.stats.skipped['fvf' + fvf.toString(16)] = 1; return; }
    const type = a.type; const nv = vcount(type, a.count); if (!nv) return;
    let vbytes, stride, first = 0, indices = null, idx32 = false, vcountTotal;
    if (kind === 'DP' || kind === 'DIP') { const s = dev.streams[0]; if (!s?.vb) return; const vb = e.d3d.objs.get(s.vb); stride = s.stride;
      if (kind === 'DP') { vbytes = m.subarray(vb.mem + a.start * stride, vb.mem + (a.start + nv) * stride); vcountTotal = nv; }
      else { const ib = e.d3d.objs.get(dev.indices); if (!ib) return; idx32 = ib.fmt === 102; const isz = idx32 ? 4 : 2;
        const base = dev.baseIndex; const lo = (base + a.minIdx) * stride; const hi = (base + a.minIdx + a.numV) * stride;
        vbytes = m.subarray(vb.mem + lo, vb.mem + hi); vcountTotal = a.numV;
        const raw = m.slice(ib.mem + a.startIdx * isz, ib.mem + (a.startIdx + nv) * isz); indices = idx32 ? new Uint32Array(raw.buffer) : new Uint16Array(raw.buffer);
        if (a.minIdx) { indices = indices.map((x) => x - a.minIdx); } } }
    else if (kind === 'DPUP') { stride = a.stride; vbytes = m.subarray(a.data, a.data + nv * stride); vcountTotal = nv; }
    else { stride = a.stride; idx32 = a.ifmt === 102; const isz = idx32 ? 4 : 2; vbytes = m.subarray(a.data + a.minIdx * stride, a.data + (a.minIdx + a.numV) * stride); vcountTotal = a.numV;
      const raw = m.slice(a.idx, a.idx + nv * isz); indices = idx32 ? new Uint32Array(raw.buffer) : new Uint16Array(raw.buffer); if (a.minIdx) indices = indices.map((x) => x - a.minIdx); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, vbytes, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, L.rhw ? 4 : 3, gl.FLOAT, false, stride, 0);
    if (L.diff >= 0) { gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, stride, L.diff); } else gl.disableVertexAttribArray(1);
    if (L.spec >= 0) { gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, L.spec); } else { gl.disableVertexAttribArray(2); gl.vertexAttrib4f(2, 0, 0, 0, 0); }
    for (let k = 0; k < 2; k++) { const ti = dev.tss[k].get(TSS.TEXCOORDINDEX) ?? k; const off = L.tex[ti & 7];
      if (off !== undefined) { gl.enableVertexAttribArray(3 + k); gl.vertexAttribPointer(3 + k, 2, gl.FLOAT, false, stride, off); } else { gl.disableVertexAttribArray(3 + k); gl.vertexAttrib2f(3 + k, 0, 0); } }
    const u = this.u; gl.uniform1i(u.uRHW, L.rhw ? 1 : 0); gl.uniform4f(u.uScreen, TW, TH, 0, 0); gl.uniform1i(u.uHasDiff, L.diff >= 0 ? 1 : 0);
    if (!L.rhw) gl.uniformMatrix4fv(u.uWVP, false, wvp(dev));
    const sw = [0, 0];
    for (let k = 0; k < 2; k++) { const ts = dev.tss[k]; const C = [ts.get(TSS.COLOROP) ?? (k === 0 ? 4 : 1), ts.get(TSS.COLORARG1) ?? 2, ts.get(TSS.COLORARG2) ?? 1];
      const A = [ts.get(TSS.ALPHAOP) ?? (k === 0 ? 2 : 1), ts.get(TSS.ALPHAARG1) ?? 2, ts.get(TSS.ALPHAARG2) ?? 1];
      gl.uniform3i(k ? u.uC1 : u.uC0, ...C); gl.uniform3i(k ? u.uA1 : u.uA0, ...A);
      gl.activeTexture(gl.TEXTURE0 + k); const tex = dev.tex[k] ? this.texture(dev.tex[k]) : null; gl.bindTexture(gl.TEXTURE_2D, tex || this.white); if (tex) this.sampler(dev, k);
      gl.uniform1i(k ? u.uHas1 : u.uHas0, tex ? 1 : 0); sw[k] = tex ? (tex.swz || 0) : 0; }
    gl.uniform2i(u.uSw, sw[0], sw[1]);
    const tf = dev.rs.get(RS.TEXTUREFACTOR) ?? 0xffffffff; gl.uniform4f(u.uTF, ((tf >> 16) & 255) / 255, ((tf >> 8) & 255) / 255, (tf & 255) / 255, ((tf >>> 24) & 255) / 255);
    gl.uniform1i(u.uAlphaTest, dev.rs.get(RS.ALPHATESTENABLE) ? 1 : 0); gl.uniform1i(u.uAlphaFunc, dev.rs.get(RS.ALPHAFUNC) ?? 8); gl.uniform1f(u.uAlphaRef, dev.rs.get(RS.ALPHAREF) ?? 0);
    this.state(dev, TH);
    const prim = [0, gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN][type];
    if (indices) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW); gl.drawElements(prim, nv, idx32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0); }
    else gl.drawArrays(prim, 0, nv);
    this.stats.draws++; this.stats.tris += a.count;
    if (this.probe && this.probe.length < 6) { const px = new Uint8Array(4); gl.readPixels(400, 300, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); const f = new Float32Array(vbytes.slice(0, Math.min(vbytes.length, stride * 4)).buffer);
      const t0 = dev.tex[0] && this.emu.d3d.objs.get(dev.tex[0]); let tsum = 0; if (t0) { const sf = t0.surfaces[0]; for (let i = 0; i < sf.size; i += 4093) tsum += m[sf.mem + i]; }
      this.probe.push({ tinfo: t0 && { w: t0.w, h: t0.h, lv: t0.surfaces.length, fmt: t0.fmt, tsum }, kind, a, fvf: fvf.toString(16), stride, L, rs: [...dev.rs], tss0: [...dev.tss[0]], tss1: [...dev.tss[1]], tex: dev.tex.slice(0, 2), vp: dev.viewport, vtx: [...f].map((x) => +x.toFixed(3)), px: [...px], err: gl.getError(), fbo: gl.checkFramebufferStatus(gl.FRAMEBUFFER) }); }
  }
  state(dev, TH) {
    const gl = this.gl, rs = dev.rs; const B = [0, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE];
    if (rs.get(RS.ALPHABLENDENABLE)) { gl.enable(gl.BLEND); gl.blendFunc(B[rs.get(RS.SRCBLEND) ?? 2] || gl.ONE, B[rs.get(RS.DESTBLEND) ?? 1] || gl.ZERO); } else gl.disable(gl.BLEND);
    const Z = [0, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS];
    if (rs.get(RS.ZENABLE) ?? 1) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(Z[rs.get(RS.ZFUNC) ?? 4] || gl.LEQUAL); } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(!!(rs.get(RS.ZWRITEENABLE) ?? 1));
    const cull = rs.get(RS.CULLMODE) ?? 3; if (cull === 1) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.frontFace(gl.CCW); gl.cullFace(cull === 3 ? gl.FRONT : gl.BACK); }
    const v = dev.viewport; gl.viewport(v[0], TH - v[1] - v[3], v[2], v[3]); gl.depthRange(v[4], v[5]);
  }
}
function layout(f) {
  let o = 0; const pos = f & 0x0e; const L = { rhw: pos === 4, diff: -1, spec: -1, tex: [] };
  if (pos === 2) o = 12; else if (pos === 4) o = 16; else if (pos >= 6 && pos <= 0x0e) o = 12 + 4 * ((pos - 4) / 2); else return null;
  if (f & 0x10) o += 12; if (f & 0x20) o += 4; if (f & 0x40) { L.diff = o; o += 4; } if (f & 0x80) { L.spec = o; o += 4; }
  const n = (f >> 8) & 15; for (let i = 0; i < n; i++) { const sz = (f >> (16 + 2 * i)) & 3; L.tex[i] = o; o += sz === 0 ? 8 : sz === 1 ? 12 : sz === 2 ? 16 : 4; }
  return L;
}
function vcount(type, n) { return type === 1 ? n : type === 2 ? n * 2 : type === 3 ? n + 1 : type === 4 ? n * 3 : (type === 5 || type === 6) ? n + 2 : 0; }
function mul(a, b) { const r = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; r[i * 4 + j] = s; } return r; }
const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function wvp(dev) { const W = dev.xf.get(256) || I4, V = dev.xf.get(2) || I4, P = dev.xf.get(3) || I4; return mul(mul(W, V), P); } // fila-vector D3D == columna-mayor GL
