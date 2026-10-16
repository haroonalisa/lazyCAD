// Compression spring: a circle swept along a helix, plus ground ends trimmed flat by planes.
export default (cad) => {
  cad.name('Spring');
  cad.params({ D: 20, wire: 2, pitch: 6, turns: 6 });
  // Wire cross-section drawn in the XZ plane at radius D/2 (a plane containing the helix axis).
  const s = cad.sketch('XZ', { id: 'wire' });
  const o = s.point(0, 0, { fixed: true, construction: true, id: 'origin' });
  const c = s.circle([10, 0], 1, { id: 'section' });
  s.diameter(c, 'wire');
  s.hDistance(o, s.centerOf(c), 'D/2');
  s.vDistance(o, s.centerOf(c), 0);
  cad.sweep(s, { id: 'coil', path: { helix: { pitch: 'pitch', turns: 'turns', axis: 'z' } } });
  // Trim the ends flat.
  cad.split({ id: 'trimBottom', body: 'coil', plane: { base: 'XY', offset: 'wire/2' }, keep: 'front' });
  cad.split({ id: 'trimTop', body: 'coil', plane: { base: 'XY', offset: 'pitch*turns - wire/2' }, keep: 'back' });
};
