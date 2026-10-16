// Bottle: loft from a rounded-square base to a circular shoulder, revolved neck, with a bored neck.
export default (cad) => {
  cad.name('Bottle');
  cad.params({ w: 50, h: 90, neckD: 24, neckH: 18, wall: 2 });
  const base = cad.sketch('XY', { id: 'base' });
  base.centerRect([0, 0], 50, 50);
  const mid = cad.sketch({ base: 'XY', offset: 'h*0.7' }, { id: 'waist' });
  mid.circle([0, 0], 28);
  const top = cad.sketch({ base: 'XY', offset: 'h' }, { id: 'shoulder' });
  const tc = top.circle([0, 0], 12);
  top.diameter(tc, 'neckD');
  cad.loft([base, mid, top], { id: 'shell' });
  const neck = cad.sketch({ base: 'XY', offset: 'h' }, { id: 'neckSk' });
  const nc = neck.circle([0, 0], 12);
  neck.diameter(nc, 'neckD');
  cad.extrude(neck, { id: 'neck', distance: 'neckH', mode: 'add' });
  // Bore through the neck
  const bore = cad.sketch({ base: 'XY', offset: 'h + neckH' }, { id: 'boreSk' });
  const bc = bore.circle([0, 0], 10);
  bore.diameter(bc, 'neckD - 2*wall');
  cad.cut(bore, { id: 'bore', distance: 'neckH + 10', reverse: true });
};
