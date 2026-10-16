// Small vector / matrix helpers. Vectors are plain arrays. Matrices are 4x4 column-major
// arrays of 16 numbers (the layout manifold and three.js use).

export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const scale = (a, s) => a.map((v) => v * s);
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const len = (a) => Math.sqrt(dot(a, a));
export const dist = (a, b) => len(sub(a, b));
export const norm = (a) => { const l = len(a); return l > 1e-15 ? scale(a, 1 / l) : a.slice(); };
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

// Rotate vector v about unit axis k by angle (radians) — Rodrigues.
export function rotateAxis(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross(k, v), kd = dot(k, v);
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd * (1 - c));
}

// Any unit vector perpendicular to n (deterministic).
export function perpendicular(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(cross(cross(n, a), n)).map((v) => -v);
}

export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a, b) { // a * b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export const translation = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
export const scaling = ([x, y, z]) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

// Rotation about a unit axis through the origin (radians).
export function rotation(axis, ang) {
  const [x, y, z] = norm(axis), c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

// Rotation about an axis through point p.
export const rotationAbout = (p, axis, ang) =>
  mul(translation(p), mul(rotation(axis, ang), translation(scale(p, -1))));

// Mirror across plane through point p with normal n.
export function mirrorMatrix(p, n) {
  const [a, b, c] = norm(n);
  const m = [
    1 - 2 * a * a, -2 * a * b, -2 * a * c, 0,
    -2 * a * b, 1 - 2 * b * b, -2 * b * c, 0,
    -2 * a * c, -2 * b * c, 1 - 2 * c * c, 0,
    0, 0, 0, 1,
  ];
  return mul(translation(p), mul(m, translation(scale(p, -1))));
}

// Euler XYZ rotation in degrees (applied X, then Y, then Z, about world axes).
export const eulerDeg = ([rx = 0, ry = 0, rz = 0]) =>
  mul(rotation([0, 0, 1], rz * D2R), mul(rotation([0, 1, 0], ry * D2R), rotation([1, 0, 0], rx * D2R)));

export const applyPoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
export const applyDir = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z,
  m[1] * x + m[5] * y + m[9] * z,
  m[2] * x + m[6] * y + m[10] * z,
];

export const det3 = (m) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

// ---- Plane frames ------------------------------------------------------------------------
// A frame is {o, x, y, n}: origin and orthonormal axes (n = x × y). Sketch coordinates (u, v)
// map to world as o + u·x + v·y.

export const STD_PLANES = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] },
};

export function frameFromNormal(o, n, xHint) {
  n = norm(n);
  let x = xHint ? sub(xHint, scale(n, dot(xHint, n))) : null;
  if (!x || len(x) < 1e-9) {
    // Prefer world X, then world Y, projected into the plane.
    for (const cand of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      x = sub(cand, scale(n, dot(cand, n)));
      if (len(x) > 0.3) break;
    }
  }
  x = norm(x);
  return { o: o.slice(), x, y: cross(n, x), n };
}

export const frameMatrix = (f) => [...f.x, 0, ...f.y, 0, ...f.n, 0, ...f.o, 1];
export const toWorld = (f, [u, v], w = 0) => [0, 1, 2].map((i) => f.o[i] + u * f.x[i] + v * f.y[i] + w * f.n[i]);
export function toLocal(f, p) {
  const d = sub(p, f.o);
  return [dot(d, f.x), dot(d, f.y), dot(d, f.n)];
}
