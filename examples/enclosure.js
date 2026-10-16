// Electronics enclosure: rounded box (sketch fillets), shelled open-top, filleted top rim,
// chamfered bottom edge, internal screw bosses with concave base fillets, and a USB cutout.
export default (cad) => {
  cad.name('Enclosure');
  cad.params({ L: 80, W: 50, H: 30, wall: 2, rc: 6, boss: 7, hole: 2.5, usbW: 9, usbH: 3.5 });

  // Outline: rectangle with rounded corners (2D fillets keep the L/W dimensions valid).
  const s = cad.sketch('XY', { id: 'outline' });
  const r = s.rect([0, 0], [80, 50]);
  s.fix(r.bl, [0, 0]);
  s.length(r.bottom, 'L');
  s.length(r.left, 'W');
  s.filletAll(r, 'rc');
  cad.extrude(s, { id: 'box', distance: 'H' });

  // Bevel the bottom edge, then hollow it out with the top face open.
  cad.chamfer({ id: 'footChamfer', body: 'box', edges: { z: 0 }, distance: 1 });
  cad.shell({ id: 'hollow', body: 'box', thickness: 'wall', open: [{ point: ['L/2', 'W/2', 'H'] }] });
  cad.fillet({ id: 'rim', body: 'box', edges: { z: 'H' }, radius: 0.8 });

  // Four screw bosses on the floor, with holes, joined to the shell.
  const b = cad.sketch({ base: 'XY', offset: 'wall' }, { id: 'bosses' });
  for (const [x, y] of [[10, 10], [70, 10], [70, 40], [10, 40]]) {
    const c = b.circle([x, y], 3.5);
    b.diameter(c, 'boss');
    const h = b.circle([x, y], 1.25);
    b.diameter(h, 'hole');
    b.concentric(c, h);
  }
  cad.extrude(b, { id: 'bossExt', distance: 'H - wall - 6', mode: 'add', target: 'box' });
  cad.fillet({ id: 'bossFillet', body: 'box', edges: { z: 'wall', concave: true, kind: 'loop' }, radius: 1 });

  // USB-C cutout in the front wall: the XZ plane is the front face (u = X, v = Z, normal −Y),
  // so `reverse` cuts toward +Y into the wall only.
  const u = cad.sketch({ base: 'XZ' }, { id: 'usb' });
  u.slot([37.25, 10], [42.75, 10], 3.5);     // 9 × 3.5 mm, centred on x = L/2
  cad.cut(u, { id: 'usbCut', distance: 'wall + 1', reverse: true });
};
