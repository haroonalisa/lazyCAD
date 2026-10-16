// L-bracket with a slotted base, a counterbored hole pattern and a gusset.
export default (cad) => {
  cad.name('L-bracket');
  cad.params({ w: 60, d: 40, t: 5, h: 45, hole: 6.5, slotLen: 12, gusset: 25 });

  // Base plate (XY), fully constrained.
  const base = cad.sketch('XY', { id: 'base' });
  const r = base.rect([0, 0], [60, 40]);
  base.fix(r.bl, [0, 0]);
  base.length(r.bottom, 'w');
  base.length(r.left, 'd');
  // two slots
  for (const x of [15, 45]) {
    const s = base.slot([x, 12], [x, 24], 6.5);
  }
  cad.extrude(base, { id: 'plate', distance: 't' });

  // Upright wall on the XZ plane at the back edge (y = d), extruded toward -y by t.
  const wall = cad.sketch({ base: 'XZ', offset: '-d' }, { id: 'wallSk' });
  const wr = wall.rect([0, 0], [60, 45]);
  wall.fix(wr.bl, [0, 0]);
  wall.length(wr.bottom, 'w');
  wall.length(wr.left, 'h');
  cad.extrude(wall, { id: 'wall', distance: 't', mode: 'add' });

  // Holes on the wall's inner face (y = d - t). Face sketches use world-aligned coordinates:
  // here u = world X and v = world Z.
  const face = cad.sketch({ face: { body: 'plate', point: [30, 35, 25] } }, { id: 'holes' });
  face.circle([15, 30], 3.25);
  face.circle([45, 30], 3.25);
  cad.cut(face, { distance: 'through', symmetric: true });

  // Gusset: triangle on the YZ plane at x = w/2, symmetric extrusion.
  const g = cad.sketch({ base: 'YZ', offset: 'w/2' }, { id: 'gussetSk' });
  g.polyline([[35, 5], [35 - 25, 5], [35, 5 + 25]], { closed: true });
  cad.extrude(g, { id: 'gusset', distance: 4, symmetric: true, mode: 'add' });
};
