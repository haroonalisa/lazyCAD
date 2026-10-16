// Exporters: STL (binary / ASCII), OBJ, 3MF (mesh), and DXF / SVG for sketches.
// Every function returns a Uint8Array or string; callers write files or trigger downloads.

import { discretize } from './sketch.js';

// Gather triangle meshes: [{name, positions: Float32Array (x,y,z...), indices: Uint32Array}]
export function meshesOf(bodies) {
  const out = [];
  for (const b of bodies) {
    if (b.visible === false) continue;
    const mesh = b.manifold.getMesh();
    const np = mesh.numProp, V = mesh.vertProperties;
    const positions = new Float32Array((V.length / np) * 3);
    for (let i = 0, j = 0; i < V.length; i += np, j += 3) { positions[j] = V[i]; positions[j + 1] = V[i + 1]; positions[j + 2] = V[i + 2]; }
    out.push({ name: b.name || b.id, positions, indices: mesh.triVerts });
  }
  return out;
}

function triNormal(P, a, b, c) {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

export function toSTLBinary(meshes) {
  const ntri = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + ntri * 50);
  const dv = new DataView(buf);
  const header = 'LazyCAD binary STL, units: mm';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, ntri, true);
  let o = 84;
  for (const { positions: P, indices: I } of meshes) {
    for (let t = 0; t < I.length; t += 3) {
      const n = triNormal(P, I[t], I[t + 1], I[t + 2]);
      for (const x of n) { dv.setFloat32(o, x, true); o += 4; }
      for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { dv.setFloat32(o, P[I[t + k] * 3 + c], true); o += 4; }
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

export function toSTLAscii(meshes, name = 'lazycad') {
  const lines = [`solid ${name}`];
  const f = (x) => x.toPrecision(9);
  for (const { positions: P, indices: I } of meshes) {
    for (let t = 0; t < I.length; t += 3) {
      const n = triNormal(P, I[t], I[t + 1], I[t + 2]);
      lines.push(` facet normal ${n.map(f).join(' ')}`, '  outer loop');
      for (let k = 0; k < 3; k++) lines.push(`   vertex ${[0, 1, 2].map((c) => f(P[I[t + k] * 3 + c])).join(' ')}`);
      lines.push('  endloop', ' endfacet');
    }
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

export function toOBJ(meshes) {
  const lines = ['# LazyCAD OBJ export, units: mm'];
  let base = 1;
  for (const { name, positions: P, indices: I } of meshes) {
    lines.push(`o ${String(name).replace(/\s+/g, '_')}`);
    for (let i = 0; i < P.length; i += 3) lines.push(`v ${P[i]} ${P[i + 1]} ${P[i + 2]}`);
    for (let t = 0; t < I.length; t += 3) lines.push(`f ${I[t] + base} ${I[t + 1] + base} ${I[t + 2] + base}`);
    base += P.length / 3;
  }
  return lines.join('\n') + '\n';
}

// ---- 3MF (zip container, stored without compression) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (data) => { let c = 0xffffffff; for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zipStore(files) { // files: [{name, data: Uint8Array}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

export function to3MF(meshes) {
  const enc = new TextEncoder();
  const objs = meshes.map((m, k) => {
    const v = [], t = [];
    for (let i = 0; i < m.positions.length; i += 3) v.push(`<vertex x="${m.positions[i]}" y="${m.positions[i + 1]}" z="${m.positions[i + 2]}"/>`);
    for (let i = 0; i < m.indices.length; i += 3) t.push(`<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`);
    return `<object id="${k + 1}" name="${String(m.name).replace(/[<&"]/g, '_')}" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objs.join('')}</resources><build>${meshes.map((_, k) => `<item objectid="${k + 1}"/>`).join('')}</build></model>`;
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ]);
}

export function exportMeshes(bodies, format) {
  const meshes = meshesOf(bodies);
  switch (format) {
    case 'stl': return toSTLBinary(meshes);
    case 'stl-ascii': return toSTLAscii(meshes);
    case 'obj': return toOBJ(meshes);
    case '3mf': return to3MF(meshes);
  }
  throw new Error(`Unknown export format "${format}" (stl | stl-ascii | obj | 3mf)`);
}

// ---- 2D sketch export (sketch coordinates, mm) ----

export function sketchToDXF(sketchResult, { includeConstruction = false } = {}) {
  const { sketch, byId } = sketchResult;
  const L = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const P = (id) => byId.get(id);
  for (const e of sketch.entities) {
    if (e.construction && !includeConstruction) continue;
    const layer = e.construction ? 'CONSTRUCTION' : '0';
    if (e.type === 'line') {
      const a = P(e.p1), b = P(e.p2);
      L.push('0', 'LINE', '8', layer, '10', a.x, '20', a.y, '30', 0, '11', b.x, '21', b.y, '31', 0);
    } else if (e.type === 'circle') {
      const c = P(e.center);
      L.push('0', 'CIRCLE', '8', layer, '10', c.x, '20', c.y, '30', 0, '40', e.r);
    } else if (e.type === 'arc') {
      const c = P(e.center), s = P(e.start), t = P(e.end);
      const r = Math.hypot(s.x - c.x, s.y - c.y);
      const a0 = Math.atan2(s.y - c.y, s.x - c.x) * 180 / Math.PI, a1 = Math.atan2(t.y - c.y, t.x - c.x) * 180 / Math.PI;
      L.push('0', 'ARC', '8', layer, '10', c.x, '20', c.y, '30', 0, '40', r, '50', a0, '51', a1);
    } else if (e.type === 'bezier') {
      const pts = discretize(byId, e, 0.005);
      for (let i = 0; i + 1 < pts.length; i++) L.push('0', 'LINE', '8', layer, '10', pts[i][0], '20', pts[i][1], '30', 0, '11', pts[i + 1][0], '21', pts[i + 1][1], '31', 0);
    }
  }
  L.push('0', 'ENDSEC', '0', 'EOF');
  return L.join('\n') + '\n';
}

export function sketchToSVG(sketchResult, { includeConstruction = false, stroke = '#000', margin = 5 } = {}) {
  const { sketch, polylines } = sketchResult;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const paths = [];
  for (const e of sketch.entities) {
    if (e.type === 'point' || (e.construction && !includeConstruction)) continue;
    const pts = polylines.get(e.id);
    if (!pts) continue;
    for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    paths.push(`<path d="M${pts.map(([x, y]) => `${x.toFixed(4)},${(-y).toFixed(4)}`).join('L')}" fill="none" stroke="${stroke}" stroke-width="0.2"${e.construction ? ' stroke-dasharray="1 1"' : ''}/>`);
  }
  if (!paths.length) { minX = minY = 0; maxX = maxY = 1; }
  const w = maxX - minX + 2 * margin, h = maxY - minY + 2 * margin;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${minX - margin} ${-maxY - margin} ${w} ${h}">\n${paths.join('\n')}\n</svg>\n`;
}
