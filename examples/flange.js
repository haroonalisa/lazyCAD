// Pipe flange: revolved half-section + one bolt hole patterned around the axis. Fully parametric:
// change any parameter (e.g. `node cli/cad.mjs set bolts=8 od=140`) and everything follows.
export default (cad) => {
  cad.name('Pipe flange');
  cad.params({ od: 120, id: 50, t: 14, hubD: 76, hubH: 22, boltPCD: 95, boltD: 11, bolts: 6 });

  // Half cross-section in the XZ plane (u = radius, v = height), revolved about the sketch V axis (= world Z).
  const s = cad.sketch('XZ', { id: 'profile' });
  const o = s.point(0, 0, { fixed: true, construction: true, id: 'origin' });
  const p = s.polyline([[25, 0], [60, 0], [60, 14], [38, 14], [38, 36], [25, 36]], { closed: true });
  const [a, b, , d] = p.points;
  const [l1, l2, l3, l4, l5, l6] = p.lines;
  [l1, l3, l5].forEach((l) => s.horizontal(l));
  [l2, l4, l6].forEach((l) => s.vertical(l));
  s.vDistance(o, a, 0);           // sits on the XY plane
  s.hDistance(o, a, 'id/2');      // bore
  s.hDistance(o, b, 'od/2');      // outer diameter
  s.hDistance(o, d, 'hubD/2');    // hub diameter
  s.length(l2, 't');              // flange thickness
  s.length(l6, 't + hubH');       // overall height
  cad.revolve(s, { id: 'body', axis: 'v' });

  // One bolt hole sketched on the flange's top face plane, cut through, then patterned.
  const h = cad.sketch({ base: 'XY', offset: 't' }, { id: 'boltSk' });
  const ho = h.point(0, 0, { fixed: true, construction: true, id: 'origin' });
  const c1 = h.circle([47.5, 0], 5.5, { id: 'hole' });
  h.diameter(c1, 'boltD');
  h.hDistance(ho, h.centerOf(c1), 'boltPCD/2');
  h.vDistance(ho, h.centerOf(c1), 0);
  cad.cut(h, { id: 'boltHole', distance: 't', reverse: true });
  cad.pattern({ id: 'boltPattern', of: 'boltHole', kind: 'circular', axis: 'z', count: 'bolts' });
};
