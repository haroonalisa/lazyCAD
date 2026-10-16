// Headless software renderer: draws bodies into a PNG (z-buffered, flat shaded, with feature
// edges) so models can be checked visually without a browser. Node only (uses zlib).

import zlib from 'node:zlib';

const VIEWS = {
  iso: { eye: [1, -1, 0.8], up: [0, 0, 1], label: 'ISO' },
  front: { eye: [0, -1, 0], up: [0, 0, 1], label: 'FRONT (-Y)' },
  top: { eye: [0, 0, 1], up: [0, 1, 0], label: 'TOP (+Z)' },
  right: { eye: [1, 0, 0], up: [0, 0, 1], label: 'RIGHT (+X)' },
  back: { eye: [0, 1, 0], up: [0, 0, 1], label: 'BACK (+Y)' },
  left: { eye: [-1, 0, 0], up: [0, 0, 1], label: 'LEFT (-X)' },
  bottom: { eye: [0, 0, -1], up: [0, -1, 0], label: 'BOTTOM (-Z)' },
  iso2: { eye: [-1, 1, 0.8], up: [0, 0, 1], label: 'ISO (BACK)' },
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// 5x7 bitmap font (subset)
const FONT = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111', M: '10001110111010110101100011000110001',
  N: '10001110011010110011100011000110001', O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111', W: '10001100011000110101101011101110001',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11111000100010000010000011000101110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100', '.': '00000000000000000000000000110001100', '-': '00000000000000011111000000000000000',
  '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000', '+': '00000001000010011111001000010000000',
  ':': '00000011000110000000011000110000000', ' ': '00000000000000000000000000000000000', x: '00000000001000101010001000101010001',
  m: '00000000001101010101101011010110101', '/': '00001000010001000100010001000010000',
};

class Canvas {
  constructor(w, h, bg = [246, 247, 249]) {
    this.w = w; this.h = h;
    this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.rgb.set(bg, i * 3);
    this.z = new Float32Array(w * h).fill(Infinity);
  }
  set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.rgb.set(c, (y * this.w + x) * 3); }
  text(s, x, y, c = [60, 64, 72], scale = 2) {
    for (const ch of String(s)) {
      const g = FONT[ch] ?? FONT[ch.toUpperCase()] ?? FONT[' '];
      for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++)
        if (g[r * 5 + k] === '1') for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) this.set(x + k * scale + a, y + r * scale + b, c);
      x += 6 * scale;
    }
  }
  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.rgb.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1);
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// meshes: [{positions, indices, color:'#rrggbb'}]
function drawView(cv, meshes, view, ox, oy, w, h, bounds) {
  const f = norm(view.eye.map((v) => -v)); // looking direction
  const r = norm(cross(f, view.up)), u = cross(r, f);
  // Fit using the 8 corners of the overall bbox (so every view shares a consistent scale per view).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    const p = [x, y, z];
    minX = Math.min(minX, dot(p, r)); maxX = Math.max(maxX, dot(p, r));
    minY = Math.min(minY, dot(p, u)); maxY = Math.max(maxY, dot(p, u));
  }
  const pad = 30, top = 26;
  const s = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1e-6), (h - 2 * pad - top) / Math.max(maxY - minY, 1e-6));
  const cx = ox + w / 2 - s * (minX + maxX) / 2, cy = oy + top + (h - top) / 2 + s * (minY + maxY) / 2;
  const proj = (p) => [cx + s * dot(p, r), cy - s * dot(p, u), dot(p, f)];
  const light = norm(sub(norm(view.eye), [0.3 * r[0], 0.3 * r[1], -0.5]));
  const lines = [];
  for (const m of meshes) {
    const P = m.positions, I = m.indices, col = hex(m.color || '#8aa4c8');
    const V = []; for (let i = 0; i < P.length; i += 3) V.push(proj([P[i], P[i + 1], P[i + 2]]));
    const triN = [], triBad = [];
    for (let t = 0; t < I.length; t += 3) {
      const a = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
      const cr = cross(sub(b, a), sub(c, a));
      const longest = Math.max(Math.hypot(...sub(b, a)), Math.hypot(...sub(c, b)), Math.hypot(...sub(a, c)));
      const n = norm(cr);
      triN.push(n);
      triBad.push(Math.hypot(...cr) / longest < 1e-5);
      const lam = Math.abs(dot(n, light)) * 0.6 + 0.4;
      const facing = dot(n, f) < 0 ? 1 : 0.55;
      const c3 = col.map((v) => Math.min(255, Math.round(v * lam * facing)));
      raster(cv, V[I[t]], V[I[t + 1]], V[I[t + 2]], c3, ox, oy, w, h);
    }
    // Feature edges: dihedral angle above ~30°, plus silhouettes.
    const edges = new Map();
    for (let t = 0, k = 0; t < I.length; t += 3, k++) for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + (e + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const rec = edges.get(key);
      if (rec) rec.push(k); else edges.set(key, [k]);
    }
    for (const [key, ts] of edges) {
      let draw = ts.length !== 2;
      if (!draw) {
        const [n1, n2] = [triN[ts[0]], triN[ts[1]]];
        if (triBad[ts[0]] || triBad[ts[1]]) continue; // sliver triangles have no meaningful normal
        const d1 = dot(n1, f), d2 = dot(n2, f);
        draw = dot(n1, n2) < 0.86 || (d1 < -1e-4 && d2 > 1e-4) || (d1 > 1e-4 && d2 < -1e-4);
      }
      if (draw) { const [a, b] = key.split(',').map(Number); lines.push([V[a], V[b]]); }
    }
  }
  for (const [a, b] of lines) line3(cv, a, b, [40, 44, 52], ox, oy, w, h);
  // axis triad
  const tx = ox + 34, ty = oy + h - 34;
  for (const [ax, c, lab] of [[[1, 0, 0], [210, 50, 50], 'X'], [[0, 1, 0], [40, 160, 60], 'Y'], [[0, 0, 1], [50, 90, 220], 'Z']]) {
    const ex = tx + 22 * dot(ax, r), ey = ty - 22 * dot(ax, u);
    if (Math.hypot(ex - tx, ey - ty) < 3) { cv.text(lab, tx - 4, ty - 6, c, 1); continue; }
    line2(cv, tx, ty, ex, ey, c);
    cv.text(lab, Math.round(ex + (ex - tx) * 0.25) - 2, Math.round(ey + (ey - ty) * 0.25) - 3, c, 1);
  }
  cv.text(view.label, ox + 10, oy + 8, [80, 86, 96], 2);
}

function raster(cv, a, b, c, col, ox, oy, w, h) {
  const minX = Math.max(ox, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(ox + w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(oy, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(oy + h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-12) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    let w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
    let w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
    let w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
    const i = y * cv.w + x;
    if (z < cv.z[i]) { cv.z[i] = z; cv.rgb.set(col, i * 3); }
  }
}

function line3(cv, a, b, col, ox, oy, w, h) {
  const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = Math.round(a[0] + (b[0] - a[0]) * t - 0.5), y = Math.round(a[1] + (b[1] - a[1]) * t - 0.5);
    if (x < ox || y < oy || x >= ox + w || y >= oy + h) continue;
    const z = a[2] + (b[2] - a[2]) * t, k = y * cv.w + x;
    let vis = z <= cv.z[k] + 0.02 * Math.abs(cv.z[k] || 1) + 1e-3;
    if (!vis) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k2 = k + dy * cv.w + dx; if (k2 >= 0 && k2 < cv.z.length && z <= cv.z[k2] + 1e-3) vis = true; }
    if (vis) cv.rgb.set(col, k * 3);
  }
}
function line2(cv, x0, y0, x1, y1, col) {
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let i = 0; i <= n; i++) { const t = i / n; cv.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), col); }
}

/**
 * Render meshes to PNG bytes.
 * @param meshes [{positions, indices, color}]
 * @param opts {views: ['iso','front','top','right'] | 'grid' | 'iso', size: tile px, caption}
 */
export function renderPNG(meshes, opts = {}) {
  let views = opts.views || 'grid';
  if (views === 'grid' || views === 'all') views = ['iso', 'front', 'top', 'right'];
  if (typeof views === 'string') views = views.split(',');
  const tile = opts.size || (views.length === 1 ? 800 : 480);
  const cols = views.length === 1 ? 1 : 2, rows = Math.ceil(views.length / cols);
  const capH = opts.caption ? 30 : 0;
  const cv = new Canvas(cols * tile, rows * tile + capH);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    bounds.min[k] = Math.min(bounds.min[k], m.positions[i + k]); bounds.max[k] = Math.max(bounds.max[k], m.positions[i + k]);
  }
  if (!Number.isFinite(bounds.min[0])) { bounds.min = [-1, -1, -1]; bounds.max = [1, 1, 1]; }
  views.forEach((v, i) => {
    const view = VIEWS[v];
    if (!view) throw new Error(`Unknown view "${v}" (${Object.keys(VIEWS).join(', ')})`);
    const ox = (i % cols) * tile, oy = Math.floor(i / cols) * tile;
    drawView(cv, meshes, view, ox, oy, tile, tile, bounds);
    // tile borders
    for (let x = ox; x < ox + tile; x++) cv.set(x, oy, [215, 218, 224]);
    for (let y = oy; y < oy + tile; y++) cv.set(ox, y, [215, 218, 224]);
  });
  if (opts.caption) cv.text(opts.caption, 10, rows * tile + 8, [40, 44, 52], 2);
  return cv.png();
}
