// The 3D plate: the Workhorse bed, the models on it, the camera, and mouse handling.
//
// World axes match the printer: X to the right, Y to the back, Z up. The bed is drawn centred on
// 0,0 (like Cura); exportPlateSTL() shifts to printer coordinates (front-left corner is 0,0).
//
// Each model keeps its turns and mirrors baked into its own geometry (so the size shown in mm is
// always the true size along the printer's axes), sits with its lowest point on the bed, and keeps
// its scale on the mesh. Only X/Y position is free: a model can never float or sink.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_COLOR = new THREE.Color('#fb923c');
const OVERHANG_COLOR = new THREE.Color('#e5484d');
const OUTSIDE_TINT = new THREE.Color('#7d848f');
// Faces touching the bed never need support, even when they face down.
const ON_BED_MM = 0.3;

const THEMES = {
  light: { bg: '#e8ecf1', plate: '#cfd5dc', margin: '#bcc3cc', minor: '#b8bfc8', major: '#98a1ac', volume: '#8d97a3', text: '#6b7480' },
  dark: { bg: '#0d1117', plate: '#232932', margin: '#1b2027', minor: '#2d343e', major: '#414a56', volume: '#56606d', text: '#7d8792' },
};

const VIEWS = {
  home: { pos: [0, -430, 300], target: [0, 15, 30] },
  front: { pos: [0, -620, 120], target: [0, 0, 80] },
  top: { pos: [0, -0.01, 700], target: [0, 0, 0] },
  left: { pos: [-620, 0, 120], target: [0, 0, 80] },
  right: { pos: [620, 0, 120], target: [0, 0, 80] },
  // From under the bed. The plate is only drawn from above, so it turns see-through and the red
  // undersides that need support show up.
  below: { pos: [0, -330, -230], target: [0, 0, 20] },
};

let nextId = 1;

export class Model {
  constructor(name, positions) {
    this.id = nextId++;
    this.name = name;
    this.original = positions.slice();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.04 });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.model = this;
    this.baseSize = new THREE.Vector3(); // size before scale, mm
    this.overhangArea = 0; // mm², faces that will need support
    this.outside = false;
    normalize(this);
  }

  get triangles() {
    return this.geometry.attributes.position.count / 3;
  }

  /** True size in mm along X, Y, Z. */
  get size() {
    return this.baseSize.clone().multiply(this.mesh.scale);
  }

  get position() {
    return this.mesh.position;
  }

  /** Volume in mm³ (signed tetrahedra; correct for closed meshes). */
  get volume() {
    const p = this.geometry.attributes.position.array;
    let v = 0;
    for (let i = 0; i < p.length; i += 9) {
      v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
        - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
        + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
    }
    const s = this.mesh.scale;
    return Math.abs(v / 6) * s.x * s.y * s.z;
  }
}

// Centre X/Y on 0, put the lowest point at Z = 0, recompute normals and bounds.
function normalize(model) {
  const g = model.geometry;
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  g.computeBoundingBox();
  g.boundingBox.getSize(model.baseSize);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.attributes.position.needsUpdate = true;
}

// Apply a matrix to the model's own geometry. A mirror turns triangles inside out, so swap two
// corners of each one to keep the outside facing out.
function bake(model, matrix) {
  const g = model.geometry;
  g.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = p[i + 3 + k];
        p[i + 3 + k] = p[i + 6 + k];
        p[i + 6 + k] = t;
      }
    }
  }
  normalize(model);
}

export class Viewer extends EventTarget {
  constructor(host, printer) {
    super();
    this.host = host;
    this.printer = printer;
    this.models = [];
    this.selected = null;
    this.layFlatPicking = false;
    this.overhangCos = Math.cos(THREE.MathUtils.degToRad(90 - printer.supportAngleDeg));
    this.themeName = 'light';

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '3D view of the printer bed');

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-200, -300, 500);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.55);
    rim.position.set(300, 400, 200);
    this.scene.add(rim);

    this.buildBed();

    this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x2f81f7);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    // Our pointer handler goes on before OrbitControls', so grabbing a model can stop the camera
    // from turning at the same time.
    this.raycaster = new THREE.Raycaster();
    this.drag = null;
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 1800;
    this.controls.maxPolarAngle = Math.PI * 0.8; // may dip under the see-through bed to check undersides
    this.controls.addEventListener('change', () => this.requestRender());

    this.setView('home', false);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  // ---- Scene: bed, grid, build volume -------------------------------------------------------

  buildBed() {
    const { x: W, y: D, z: H } = this.printer.bed;
    const m = this.printer.edgeMarginMm;
    this.bedGroup = new THREE.Group();

    // The plate, with a darker band where models may not go.
    const outer = new THREE.Shape();
    outer.moveTo(-W / 2, -D / 2); outer.lineTo(W / 2, -D / 2); outer.lineTo(W / 2, D / 2); outer.lineTo(-W / 2, D / 2);
    const inner = new THREE.Path();
    inner.moveTo(-W / 2 + m, -D / 2 + m); inner.lineTo(-W / 2 + m, D / 2 - m); inner.lineTo(W / 2 - m, D / 2 - m); inner.lineTo(W / 2 - m, -D / 2 + m);
    outer.holes.push(inner);
    this.marginMat = new THREE.MeshBasicMaterial();
    const band = new THREE.Mesh(new THREE.ShapeGeometry(outer), this.marginMat);
    band.position.z = -0.05;
    this.plateMat = new THREE.MeshBasicMaterial();
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(W - 2 * m, D - 2 * m), this.plateMat);
    plate.position.z = -0.06;
    this.bedGroup.add(band, plate);

    // Grid: 10 mm lines, heavier every 50 mm, from the centre out (like Cura).
    const minor = [];
    const major = [];
    for (let v = 0; v <= W / 2; v += 10) {
      for (const s of v === 0 ? [1] : [1, -1]) {
        const list = v % 50 === 0 ? major : minor;
        list.push(s * v, -D / 2, 0, s * v, D / 2, 0);
      }
    }
    for (let v = 0; v <= D / 2; v += 10) {
      for (const s of v === 0 ? [1] : [1, -1]) {
        const list = v % 50 === 0 ? major : minor;
        list.push(-W / 2, s * v, 0, W / 2, s * v, 0);
      }
    }
    const lines = (arr, mat) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, mat);
    };
    this.minorMat = new THREE.LineBasicMaterial();
    this.majorMat = new THREE.LineBasicMaterial();
    this.bedGroup.add(lines(minor, this.minorMat), lines(major, this.majorMat));

    // Build volume outline.
    this.volumeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 });
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H));
    const volume = new THREE.LineSegments(box, this.volumeMat);
    volume.position.z = H / 2;
    this.bedGroup.add(volume);

    // Printer axes at the front-left corner, which is 0,0 on the real printer.
    const axis = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...to)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
      l.position.set(-W / 2, -D / 2, 0.1);
      return l;
    };
    this.bedGroup.add(axis([24, 0, 0], 0xe5484d), axis([0, 24, 0], 0x30a46c), axis([0, 0, 24], 0x3e63dd));

    // "FRONT" painted on the floor in front of the bed, so students know which way is which.
    this.frontCanvas = document.createElement('canvas');
    this.frontCanvas.width = 512;
    this.frontCanvas.height = 64;
    this.frontTexture = new THREE.CanvasTexture(this.frontCanvas);
    this.frontTexture.anisotropy = 4;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 15),
      new THREE.MeshBasicMaterial({ map: this.frontTexture, transparent: true, depthWrite: false }),
    );
    label.position.set(0, -D / 2 - 12, 0);
    this.bedGroup.add(label);

    this.scene.add(this.bedGroup);
  }

  setTheme(name) {
    this.themeName = name === 'dark' ? 'dark' : 'light';
    const t = THEMES[this.themeName];
    this.scene.background = new THREE.Color(t.bg);
    this.plateMat.color.set(t.plate);
    this.marginMat.color.set(t.margin);
    this.minorMat.color.set(t.minor);
    this.majorMat.color.set(t.major);
    this.volumeMat.color.set(t.volume);
    const ctx = this.frontCanvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 64);
    ctx.fillStyle = t.text;
    ctx.font = '600 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FRONT', 256, 34);
    this.frontTexture.needsUpdate = true;
    this.requestRender();
  }

  // ---- Rendering ----------------------------------------------------------------------------

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // Draw only when something changed: kind to slow Chromebooks and their batteries.
  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  setView(name, animate = true) {
    const v = VIEWS[name] ?? VIEWS.home;
    const endPos = new THREE.Vector3(...v.pos);
    const endTarget = new THREE.Vector3(...v.target);
    if (!animate) {
      this.camera.position.copy(endPos);
      this.controls?.target.copy(endTarget);
      this.controls?.update();
      this.requestRender();
      return;
    }
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 380);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.camera.position.lerpVectors(startPos, endPos, e);
      this.controls.target.lerpVectors(startTarget, endTarget, e);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- Models -------------------------------------------------------------------------------

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  changed() {
    for (const m of this.models) this.checkFit(m);
    this.updateSelectionBox();
    this.requestRender();
    this.emit('change');
  }

  addModel(name, positions) {
    const model = new Model(name, positions);
    this.paint(model);
    this.models.push(model);
    this.scene.add(model.mesh);
    this.placeFree(model);
    this.select(model);
    this.changed();
    return model;
  }

  remove(model) {
    if (!model) return;
    this.scene.remove(model.mesh);
    model.geometry.dispose();
    model.material.dispose();
    this.models = this.models.filter((m) => m !== model);
    if (this.selected === model) this.select(null);
    this.changed();
  }

  clear() {
    for (const m of [...this.models]) this.remove(m);
  }

  duplicate(model) {
    if (!model) return null;
    const copy = new Model(model.name, model.geometry.attributes.position.array.slice());
    copy.original = model.original.slice();
    copy.mesh.scale.copy(model.mesh.scale);
    this.paint(copy);
    this.models.push(copy);
    this.scene.add(copy.mesh);
    this.placeFree(copy);
    this.select(copy);
    this.changed();
    return copy;
  }

  select(model) {
    this.selected = model ?? null;
    for (const m of this.models) this.tint(m);
    this.updateSelectionBox();
    this.requestRender();
    this.emit('select', this.selected);
  }

  tint(model) {
    const mat = model.material;
    mat.color.copy(model.outside ? OUTSIDE_TINT : new THREE.Color(1, 1, 1));
    mat.emissive.set(model === this.selected ? 0x2a1405 : 0x000000);
  }

  updateSelectionBox() {
    const m = this.selected;
    if (!m) {
      this.selectionBox.visible = false;
      return;
    }
    const s = m.size;
    const p = m.position;
    this.selectionBox.box.min.set(p.x - s.x / 2, p.y - s.y / 2, 0);
    this.selectionBox.box.max.set(p.x + s.x / 2, p.y + s.y / 2, s.z);
    this.selectionBox.material.color.set(m.outside ? 0xe5484d : 0x2f81f7);
    this.selectionBox.visible = true;
  }

  // Paint faces that will need support red. Runs after any turn, mirror or scale.
  paint(model) {
    const p = model.geometry.attributes.position.array;
    const c = model.geometry.attributes.color.array;
    const s = model.mesh.scale;
    let area = 0;
    for (let i = 0; i < p.length; i += 9) {
      const ax = p[i] * s.x, ay = p[i + 1] * s.y, az = p[i + 2] * s.z;
      const ux = p[i + 3] * s.x - ax, uy = p[i + 4] * s.y - ay, uz = p[i + 5] * s.z - az;
      const vx = p[i + 6] * s.x - ax, vy = p[i + 7] * s.y - ay, vz = p[i + 8] * s.z - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const minZ = Math.min(az, p[i + 5] * s.z, p[i + 8] * s.z);
      const overhang = nz / len < -this.overhangCos && minZ > ON_BED_MM;
      if (overhang) area += len / 2;
      const col = overhang ? OVERHANG_COLOR : MODEL_COLOR;
      for (let k = 0; k < 9; k += 3) {
        c[i + k] = col.r; c[i + k + 1] = col.g; c[i + k + 2] = col.b;
      }
    }
    model.overhangArea = area;
    model.geometry.attributes.color.needsUpdate = true;
  }

  limits() {
    const { x, y } = this.printer.bed;
    const m = this.printer.edgeMarginMm;
    return { x: x / 2 - m, y: y / 2 - m };
  }

  checkFit(model) {
    const s = model.size;
    const p = model.position;
    const lim = this.limits();
    const eps = 1e-3;
    const reasons = [];
    if (s.x > lim.x * 2 + eps || s.y > lim.y * 2 + eps) reasons.push('too wide for the bed');
    else if (Math.abs(p.x) + s.x / 2 > lim.x + eps || Math.abs(p.y) + s.y / 2 > lim.y + eps) reasons.push('hanging off the bed');
    if (s.z > this.printer.bed.z + eps) reasons.push('too tall for the printer');
    const wasOutside = model.outside;
    model.outside = reasons.length > 0;
    model.fitProblem = reasons.join(' and ');
    if (wasOutside !== model.outside) this.tint(model);
    return !model.outside;
  }

  // Put the model somewhere it does not overlap others: centre first, then outward in rings.
  placeFree(model) {
    const lim = this.limits();
    const s = model.size;
    const gap = 6;
    const others = this.models.filter((m) => m !== model);
    const hits = (x, y) => others.some((o) => {
      const os = o.size;
      return Math.abs(o.position.x - x) < (os.x + s.x) / 2 + gap && Math.abs(o.position.y - y) < (os.y + s.y) / 2 + gap;
    });
    const inside = (x, y) => Math.abs(x) + s.x / 2 <= lim.x && Math.abs(y) + s.y / 2 <= lim.y;
    for (let r = 0; r <= 140; r += 5) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 5);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2 - Math.PI / 2;
        const x = Math.round(r * Math.cos(a));
        const y = Math.round(r * Math.sin(a));
        if (inside(x, y) && !hits(x, y)) {
          model.position.set(x, y, 0);
          return;
        }
      }
    }
    model.position.set(0, 0, 0);
  }

  /** Tidy every model into rows, biggest first, centred on the bed. */
  arrangeAll() {
    if (!this.models.length) return;
    const gap = 8;
    const lim = this.limits();
    const items = [...this.models].sort((a, b) => b.size.x * b.size.y - a.size.x * a.size.y);
    const rows = [];
    let row = { items: [], width: 0, depth: 0 };
    for (const m of items) {
      const s = m.size;
      if (row.items.length && row.width + gap + s.x > lim.x * 2) {
        rows.push(row);
        row = { items: [], width: 0, depth: 0 };
      }
      row.items.push(m);
      row.width += (row.items.length > 1 ? gap : 0) + s.x;
      row.depth = Math.max(row.depth, s.y);
    }
    rows.push(row);
    const totalDepth = rows.reduce((d, r) => d + r.depth, 0) + gap * (rows.length - 1);
    let y = totalDepth / 2;
    for (const r of rows) {
      let x = -r.width / 2;
      for (const m of r.items) {
        const s = m.size;
        m.position.set(x + s.x / 2, y - r.depth / 2, 0);
        x += s.x + gap;
      }
      y -= r.depth + gap;
    }
    this.changed();
  }

  setPosition(model, x, y) {
    model.position.set(x, y, 0);
    this.changed();
  }

  /** Scale in percent per axis (100 = as loaded). */
  setScale(model, sx, sy, sz) {
    model.mesh.scale.set(sx / 100, sy / 100, sz / 100);
    this.paint(model);
    this.changed();
  }

  rotate(model, axis, degrees) {
    const m = new THREE.Matrix4();
    const r = THREE.MathUtils.degToRad(degrees);
    if (axis === 'x') m.makeRotationX(r);
    else if (axis === 'y') m.makeRotationY(r);
    else m.makeRotationZ(r);
    // Scale is along the printer's axes, so turning a squashed model keeps it squashed along the
    // same printer axis. Uniform scale (the usual case) is unaffected.
    bake(model, m);
    this.paint(model);
    this.changed();
  }

  mirror(model, axis) {
    const m = new THREE.Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1);
    bake(model, m);
    this.paint(model);
    this.changed();
  }

  /** Back to how the file loaded: turns and mirrors undone. Scale and position kept. */
  resetTurns(model) {
    const g = model.geometry;
    g.attributes.position.array.set(model.original);
    normalize(model);
    this.paint(model);
    this.changed();
  }

  /** Turn the model so this direction (in model space) points straight down. */
  pointDown(model, normal) {
    const n = normal.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
    bake(model, new THREE.Matrix4().makeRotationFromQuaternion(q));
    this.paint(model);
    this.changed();
  }

  /**
   * "Biggest flat side down": group faces by which way they point, add up their area, and put the
   * direction with the most flat area on the bed. Good for Tinkercad-style parts.
   */
  layFlatAuto(model) {
    const p = model.geometry.attributes.position.array;
    const buckets = new Map();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < p.length; i += 9) {
      a.set(p[i], p[i + 1], p[i + 2]);
      b.set(p[i + 3] - a.x, p[i + 4] - a.y, p[i + 5] - a.z);
      c.set(p[i + 6] - a.x, p[i + 7] - a.y, p[i + 8] - a.z);
      const n = b.cross(c);
      const area = n.length() / 2;
      if (area < 1e-9) continue;
      n.normalize();
      const key = `${Math.round(n.x * 40)},${Math.round(n.y * 40)},${Math.round(n.z * 40)}`;
      const e = buckets.get(key);
      if (e) {
        e.area += area;
        e.n.addScaledVector(n, area);
      } else {
        buckets.set(key, { area, n: n.clone().multiplyScalar(area) });
      }
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e.area > best.area) best = e;
    if (best) this.pointDown(model, best.n);
  }

  startLayFlatPick(on = true) {
    this.layFlatPicking = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    this.emit('layflatpick', on);
  }

  /** Make the model fit inside the bed (with margin), keeping its shape. */
  scaleToFit(model) {
    const s = model.size;
    const lim = this.limits();
    const f = Math.min((lim.x * 2) / s.x, (lim.y * 2) / s.y, this.printer.bed.z / s.z, 1) * 0.98;
    const sc = model.mesh.scale;
    this.setScale(model, sc.x * f * 100, sc.y * f * 100, sc.z * f * 100);
    this.setPosition(model, 0, 0);
  }

  frameSelection() {
    const m = this.selected;
    if (!m) return this.setView('home');
    const s = m.size;
    const r = Math.max(s.x, s.y, s.z, 20);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const target = new THREE.Vector3(m.position.x, m.position.y, s.z / 2);
    this.camera.position.copy(target.clone().addScaledVector(dir, r * 3.2));
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  // ---- Pointer ------------------------------------------------------------------------------

  pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.models.map((m) => m.mesh), false)[0];
    return hit ? { model: hit.object.userData.model, point: hit.point, face: hit.face } : null;
  }

  groundPoint(e, z) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  onPointerDown(e) {
    this.down = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return; // those pan the camera
    const hit = this.pick(e);
    if (this.layFlatPicking) {
      e.stopImmediatePropagation();
      this.down = null; // the model turns away from the cursor; this click must not deselect it
      if (hit) {
        this.select(hit.model);
        // face.normal is in model space, which already includes turns (they are baked in).
        this.pointDown(hit.model, hit.face.normal);
      }
      this.startLayFlatPick(false);
      return;
    }
    if (!hit) return;
    e.stopImmediatePropagation();
    this.select(hit.model);
    const ground = this.groundPoint(e, hit.point.z);
    if (!ground) return;
    this.drag = {
      model: hit.model,
      z: hit.point.z,
      offset: new THREE.Vector2(hit.model.position.x - ground.x, hit.model.position.y - ground.y),
      moved: false,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grabbing';
  }

  onPointerMove(e) {
    if (this.drag) {
      const g = this.groundPoint(e, this.drag.z);
      if (!g) return;
      // Allowed off the bed (it turns grey), but not so far it gets lost.
      const reach = this.printer.bed.x / 2 + 80;
      const clamp = (v) => Math.max(-reach, Math.min(reach, Math.round(v * 10) / 10));
      const x = clamp(g.x + this.drag.offset.x);
      const y = clamp(g.y + this.drag.offset.y);
      this.drag.model.position.set(x, y, 0);
      this.drag.moved = true;
      this.checkFit(this.drag.model);
      this.updateSelectionBox();
      this.requestRender();
      this.emit('dragging', this.drag.model);
      return;
    }
    if (this.layFlatPicking || e.buttons) return;
    // Hover cursor, at most every 80 ms: raycasting a big model on every mouse move is slow.
    const now = performance.now();
    if (now - (this.lastHover ?? 0) < 80) return;
    this.lastHover = now;
    this.canvas.style.cursor = this.pick(e) ? 'grab' : '';
  }

  onPointerUp(e) {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      this.canvas.style.cursor = 'grab';
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      if (moved) this.changed();
      return;
    }
    // A click (not a camera drag) on empty space clears the selection.
    if (this.down && e.button === 0 && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
      if (!this.pick(e)) this.select(null);
    }
    this.down = null;
  }

  // ---- Output -------------------------------------------------------------------------------

  /** Every model as one binary STL, in printer coordinates (front-left corner = 0,0). */
  exportPlateSTL() {
    const total = this.models.reduce((n, m) => n + m.triangles, 0);
    const buf = new ArrayBuffer(84 + total * 50);
    const view = new DataView(buf);
    const header = 'uploadmymodel plate';
    for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
    view.setUint32(80, total, true);
    let off = 84;
    const ox = this.printer.bed.x / 2;
    const oy = this.printer.bed.y / 2;
    for (const m of this.models) {
      const p = m.geometry.attributes.position.array;
      const s = m.mesh.scale;
      const t = m.position;
      for (let i = 0; i < p.length; i += 9) {
        off += 12; // normal left as 0,0,0: slicers work it out from the corners
        for (let k = 0; k < 9; k += 3) {
          view.setFloat32(off, p[i + k] * s.x + t.x + ox, true);
          view.setFloat32(off + 4, p[i + k + 1] * s.y + t.y + oy, true);
          view.setFloat32(off + 8, p[i + k + 2] * s.z, true);
          off += 12;
        }
        off += 2;
      }
    }
    return buf;
  }
}
