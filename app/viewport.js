// three.js viewport: camera/controls, body meshes, sketch display, picking, view presets.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { frameMatrix } from '../core/vec.js';

export class Viewport {
  constructor(container) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.camera = this.persp;
    this.persp.position.set(120, -160, 110);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.dirty());

    // lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6);
    dl.position.set(1, -1.5, 2);
    this.camera.add(dl);
    this.headlight = dl;
    this.scene.add(this.persp, this.ortho);

    // reference geometry
    this.refGroup = new THREE.Group();
    this.scene.add(this.refGroup);
    this.buildReference(100);

    this.bodyGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();   // passive sketches
    this.activeGroup = new THREE.Group();   // active sketch editor graphics
    this.datumGroup = new THREE.Group();
    this.helperGroup = new THREE.Group();   // measure lines, region highlights, previews
    this.scene.add(this.bodyGroup, this.sketchGroup, this.datumGroup, this.helperGroup, this.activeGroup);

    this.raycaster = new THREE.Raycaster();
    this.listeners = new Set();
    this._dirty = true;
    this.theme();
    new ResizeObserver(() => this.resize()).observe(container);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.theme());
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this._dirty) return;
      this._dirty = false;
      this.renderer.render(this.scene, this.camera);
      for (const l of this.listeners) l();
    };
    loop();
  }

  onRender(fn) { this.listeners.add(fn); }
  dirty() { this._dirty = true; }

  theme() {
    const dark = getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim() === 'dark';
    this.isDark = dark;
    this.scene.background = new THREE.Color(dark ? 0x1a1e24 : 0xe9edf2);
    this.dirty();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
    this.dirty();
  }

  updateOrtho() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const d = this.camera === this.ortho ? this.orthoHeight || 200 : this.persp.position.distanceTo(this.controls.target) * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 2;
    this.orthoHeight = d;
    const a = w / h;
    Object.assign(this.ortho, { left: -d * a / 2, right: d * a / 2, top: d / 2, bottom: -d / 2 });
    this.ortho.updateProjectionMatrix();
  }

  setOrtho(on) {
    if ((this.camera === this.ortho) === on) return;
    const t = this.controls.target.clone();
    if (on) {
      const dist = this.persp.position.distanceTo(t);
      this.orthoHeight = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 2;
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.zoom = 1;
      this.camera = this.ortho;
      this.updateOrtho();
    } else {
      const h = this.orthoHeight / this.ortho.zoom;
      const dist = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      const dir = this.ortho.position.clone().sub(t).normalize();
      this.persp.position.copy(t).addScaledVector(dir, dist);
      this.persp.up.copy(this.ortho.up);
      this.camera = this.persp;
    }
    this.camera.add(this.headlight);
    this.controls.object = this.camera;
    this.controls.update();
    this.dirty();
  }

  buildReference(size) {
    this.refGroup.clear();
    const grid = new THREE.GridHelper(size * 4, 40, 0x9aa5b5, 0xc9d0da);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    this.refGroup.add(grid);
    const axes = [[[1, 0, 0], 0xd04545], [[0, 1, 0], 0x2f9e55], [[0, 0, 1], 0x3d6fe0]];
    for (const [d, c] of axes) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...d).multiplyScalar(size * 0.4)]);
      this.refGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c })));
    }
    // origin planes (pickable)
    this.originPlanes = [];
    const mk = (name, rot, color) => {
      const s = size * 0.5;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
      m.position.set(...rot.pos);
      m.rotation.set(...rot.r);
      m.userData.plane = name;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
      m.add(edge);
      m.visible = false;
      this.refGroup.add(m);
      this.originPlanes.push(m);
    };
    const h = size * 0.25;
    mk('XY', { pos: [h, h, 0], r: [0, 0, 0] }, 0x3d6fe0);
    mk('XZ', { pos: [h, 0, h], r: [Math.PI / 2, 0, 0] }, 0x2f9e55);
    mk('YZ', { pos: [0, h, h], r: [Math.PI / 2, Math.PI / 2, 0] }, 0xd04545);
  }

  showOriginPlanes(on) { for (const p of this.originPlanes) p.visible = on; this.dirty(); }

  // ---- bodies ----
  setBodies(bodies, { highlight } = {}) {
    for (const c of this.bodyGroup.children) { c.geometry?.dispose(); c.children.forEach((k) => k.geometry?.dispose()); }
    this.bodyGroup.clear();
    for (const b of bodies) {
      if (b.visible === false || b.manifold.isEmpty()) continue;
      const mesh = b.manifold.getMesh();
      const np = mesh.numProp, V = mesh.vertProperties, T = mesh.triVerts;
      const pos = new Float32Array(T.length * 3);
      for (let i = 0; i < T.length; i++) { const v = T[i] * np; pos[i * 3] = V[v]; pos[i * 3 + 1] = V[v + 1]; pos[i * 3 + 2] = V[v + 2]; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(b.color), metalness: 0.05, roughness: 0.65, flatShading: true,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        transparent: b.ghost, opacity: b.ghost ? 0.35 : 1,
      });
      const m = new THREE.Mesh(g, mat);
      m.userData.body = b.id;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), new THREE.LineBasicMaterial({ color: this.isDark ? 0x0c0f14 : 0x2a303a }));
      edges.raycast = () => {};
      m.add(edges);
      if (highlight === b.id) mat.emissive = new THREE.Color(0x203060);
      this.bodyGroup.add(m);
    }
    this.dirty();
  }

  // ---- datum planes & passive sketches ----
  setDatums(frames, highlightId) {
    this.datumGroup.clear();
    for (const [id, f] of frames) {
      const s = 40;
      const g = new THREE.PlaneGeometry(s, s);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: id === highlightId ? 0x2f6fed : 0xc8a040, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: id === highlightId ? 0x2f6fed : 0xc8a040 })));
      m.matrixAutoUpdate = false;
      m.matrix.fromArray(frameMatrix(f));
      m.userData.datum = id;
      this.datumGroup.add(m);
    }
    this.dirty();
  }

  setPassiveSketches(list) { // [{frame, polylines:[[ [u,v]... ]], construction:[...]}]
    this.sketchGroup.clear();
    for (const s of list) {
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      grp.matrix.fromArray(frameMatrix(s.frame));
      for (const { pts, construction } of s.curves) {
        const g = new THREE.BufferGeometry().setFromPoints(pts.map(([u, v]) => new THREE.Vector3(u, v, 0.02)));
        const mat = construction
          ? new THREE.LineDashedMaterial({ color: 0xc08a30, dashSize: 1.5, gapSize: 1, transparent: true, opacity: 0.6 })
          : new THREE.LineBasicMaterial({ color: s.highlight ? 0x2f6fed : 0x5a6a85, transparent: true, opacity: 0.85 });
        const line = new THREE.Line(g, mat);
        if (construction) line.computeLineDistances();
        grp.add(line);
      }
      this.sketchGroup.add(grp);
    }
    this.dirty();
  }

  // ---- picking ----
  ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }
  ray(ev) { this.raycaster.setFromCamera(this.ndc(ev), this.camera); return this.raycaster.ray; }

  pickBody(ev) {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const hit = this.raycaster.intersectObjects(this.bodyGroup.children, false)[0];
    if (!hit) return null;
    return { body: hit.object.userData.body, point: hit.point.toArray(), normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld).toArray(), hit };
  }

  pickOriginPlane(ev) {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const objs = [...this.originPlanes.filter((p) => p.visible), ...this.datumGroup.children];
    const hit = this.raycaster.intersectObjects(objs, false)[0];
    return hit ? (hit.object.userData.plane || hit.object.userData.datum) : null;
  }

  // Nearest mesh vertex to the cursor within px pixels (for measuring).
  pickVertex(ev, px = 10) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = px;
    const v = new THREE.Vector3();
    for (const m of this.bodyGroup.children) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const s = this.toScreen(v.toArray());
        if (!s || s.behind) continue;
        const d = Math.hypot(s.x - mx, s.y - my);
        if (d < bd) { bd = d; best = v.toArray(); }
      }
    }
    return best;
  }

  // Intersect the cursor ray with a plane frame → local [u, v].
  planeUV(ev, frame) {
    const ray = this.ray(ev);
    const n = new THREE.Vector3(...frame.n), o = new THREE.Vector3(...frame.o);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    const p = ray.origin.clone().addScaledVector(ray.direction, t).sub(o);
    return [p.dot(new THREE.Vector3(...frame.x)), p.dot(new THREE.Vector3(...frame.y))];
  }

  toScreen(p) {
    const v = new THREE.Vector3(...p).project(this.camera);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, behind: v.z > 1 || v.z < -1 };
  }

  // World units per screen pixel at a world point.
  pixelSize(p) {
    const a = this.toScreen(p);
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const q = new THREE.Vector3(...p).add(right);
    const b = this.toScreen(q.toArray());
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return d > 1e-9 ? 1 / d : 1;
  }

  // ---- views ----
  boundsOfScene() {
    const box = new THREE.Box3();
    for (const g of [this.bodyGroup, this.sketchGroup, this.activeGroup, this.datumGroup]) if (g.children.length) box.expandByObject(g);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    return box;
  }

  view(name, frame) {
    const box = this.boundsOfScene();
    const c = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), name === 'normal' ? 80 : 20);
    let dir, up = new THREE.Vector3(0, 0, 1);
    switch (name) {
      case 'front': dir = new THREE.Vector3(0, -1, 0); break;
      case 'top': dir = new THREE.Vector3(0, 0, 1); up = new THREE.Vector3(0, 1, 0); break;
      case 'right': dir = new THREE.Vector3(1, 0, 0); break;
      case 'normal':
        if (!frame) return;
        dir = new THREE.Vector3(...frame.n); up = new THREE.Vector3(...frame.y);
        break;
      case 'fit': dir = this.camera.position.clone().sub(this.controls.target).normalize(); up = this.camera.up.clone(); break;
      default: dir = new THREE.Vector3(1, -1.2, 0.9).normalize();
    }
    const target = name === 'normal' && frame ? new THREE.Vector3(...frame.o) : c;
    if (name === 'normal' && this.activeGroup.children.length) {
      const b2 = new THREE.Box3().expandByObject(this.activeGroup);
      if (!b2.isEmpty()) b2.getCenter(target);
    }
    const aspect = this.el.clientWidth / Math.max(1, this.el.clientHeight);
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const dist = (size * 0.6) / Math.tan(fov / 2) / Math.min(1, aspect);
    this.camera.up.copy(up);
    this.camera.position.copy(target).addScaledVector(dir.normalize(), dist);
    this.controls.target.copy(target);
    if (this.camera === this.ortho) { this.orthoHeight = size * 1.15 / Math.min(1, aspect); this.ortho.zoom = 1; this.updateOrtho(); }
    this.camera.lookAt(target);
    this.controls.update();
    this.dirty();
  }
}

export { THREE };
