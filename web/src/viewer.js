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
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { LINE_TYPES } from './gcode.js';

// Picking a 500k-triangle model by testing every triangle takes ~0.25 s on a slow Chromebook, too
// slow for hover and drag. three-mesh-bvh (MIT) builds a search tree per model instead. Building
// one takes a moment, so it is built when the browser is idle after the shape changes
// (scheduleTrees), and only for models up to TREE_MAX_TRIANGLES; without one, hover uses the
// model's box and a click does a plain (slower) raycast. The library's worker builder is not used: it borrows the position array
// while building, and this app reads that array (paint, turns) at any time.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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
    // flatShading: the GPU works out each face's normal, so no normals array is stored or rebuilt.
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.04, flatShading: true });
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

// Centre X/Y on 0, put the lowest point at Z = 0, and reset the bounds. Plain loops over the
// typed array: three's helpers make a Vector3 per corner, which is slow on big models.
function normalize(model) {
  const g = model.geometry;
  const p = g.attributes.position.array;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= cx;
    p[i + 1] -= cy;
    p[i + 2] -= z0;
  }
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
  model.baseSize.set(sx, sy, sz);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-sx / 2, -sy / 2, 0), new THREE.Vector3(sx / 2, sy / 2, sz));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, sz / 2), Math.hypot(sx, sy, sz) / 2);
  g.attributes.position.needsUpdate = true;
  if (g.boundsTree) g.disposeBoundsTree(); // the shape moved; rebuilt on the next pick
}

// Apply a matrix to the model's own geometry. A mirror turns triangles inside out, so swap two
// corners of each one to keep the outside facing out.
function bake(model, matrix) {
  const p = model.geometry.attributes.position.array;
  const e = matrix.elements;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    p[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    p[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    p[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  if (matrix.determinant() < 0) {
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

const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
// Above this, building the tree freezes a slow Chromebook for over a second, which costs more than
// it saves: such models use box hover and a plain raycast on click (~0.1-0.4 s) instead.
const TREE_MAX_TRIANGLES = 200_000;
const wantsTree = (m) => !m.geometry.boundsTree && m.triangles <= TREE_MAX_TRIANGLES;

export class Viewer extends EventTarget {
  constructor(host, printer) {
    super();
    this.host = host;
    this.printer = printer;
    this.models = [];
    this.selected = null; // the model the tool panel shows (the last one clicked)
    this.selection = new Set(); // every selected model; Ctrl + click adds more
    this.gizmo = null; // 'rotate' shows the rotate rings
    this.stage = 'prepare';
    this.previewParts = [];
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
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

    this.selectionBoxes = [];
    this.buildRings();

    // "45°" next to the cursor while a rotate ring is dragged.
    this.angleLabel = document.createElement('div');
    this.angleLabel.className = 'angle-label';
    this.angleLabel.hidden = true;
    host.appendChild(this.angleLabel);

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

  // ---- Rotate rings (Cura's rotate tool) ------------------------------------------------------
  // Three rings round the selected model: red turns about X, green about Y, blue about Z. Each has a
  // thin visible ring and a fat invisible one that is easy to grab. Turns snap to 15°, like Cura.

  buildRings() {
    this.rings = new THREE.Group();
    this.rings.visible = false;
    this.ringParts = {};
    const make = (axis, color) => {
      const group = new THREE.Group();
      const vis = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.024, 8, 128),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      vis.renderOrder = 10;
      const hit = new THREE.Mesh(new THREE.TorusGeometry(1, 0.075, 6, 64), new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.axis = axis;
      group.add(vis, hit);
      if (axis === 'x') group.rotation.y = Math.PI / 2;
      else if (axis === 'y') group.rotation.x = Math.PI / 2;
      this.rings.add(group);
      this.ringParts[axis] = { vis, hit, color };
    };
    make('x', 0xe5484d);
    make('y', 0x30a46c);
    make('z', 0x3e63dd);
    this.scene.add(this.rings);
  }

  setGizmo(name) {
    this.gizmo = name;
    this.updateRings();
    this.requestRender();
  }

  updateRings() {
    const m = this.selection.size === 1 ? this.selected : null;
    const show = this.gizmo === 'rotate' && !!m && !this.ringDrag && this.stage !== 'preview';
    this.rings.visible = show || !!this.ringDrag;
    if (!m || this.ringDrag) return;
    const s = m.size;
    this.rings.position.set(m.position.x, m.position.y, s.z / 2);
    this.rings.scale.setScalar(Math.max(s.x, s.y, s.z) * 0.62 + 6);
  }

  hitRing(e) {
    if (!this.rings.visible) return null;
    this.setRay(e);
    const hits = this.raycaster.intersectObjects(Object.values(this.ringParts).map((p) => p.hit), false);
    return hits[0]?.object.userData.axis ?? null;
  }

  // Angle of the pointer round the ring's axis, in the ring's plane (radians, right-handed).
  ringAngle(e) {
    const d = this.ringDrag;
    this.setRay(e);
    const p = this.raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!p) return null;
    const v = p.sub(d.center);
    return Math.atan2(v.dot(d.w), v.dot(d.u));
  }

  startRingDrag(e, axis) {
    const m = this.selected;
    const n = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const basis = { x: [[0, 1, 0], [0, 0, 1]], y: [[0, 0, 1], [1, 0, 0]], z: [[1, 0, 0], [0, 1, 0]] }[axis];
    const center = this.rings.position.clone();
    this.ringDrag = {
      model: m,
      axis,
      n,
      center,
      u: new THREE.Vector3(...basis[0]),
      w: new THREE.Vector3(...basis[1]),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, center),
      startPos: m.position.clone(),
      total: 0,
      snapped: 0,
    };
    const a = this.ringAngle(e);
    if (a === null) {
      this.ringDrag = null;
      return false;
    }
    this.ringDrag.last = a;
    for (const [k, part] of Object.entries(this.ringParts)) part.vis.material.opacity = k === axis ? 1 : 0.25;
    return true;
  }

  moveRingDrag(e) {
    const d = this.ringDrag;
    const a = this.ringAngle(e);
    if (a === null) return;
    let delta = a - d.last;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    d.last = a;
    d.total += delta;
    const deg = Math.round(THREE.MathUtils.radToDeg(d.total) / 15) * 15;
    if (deg !== d.snapped) {
      d.snapped = deg;
      // Preview: turn about the model's middle, then scale, in that order, because that is what
      // baking does (turns go into the shape, scale stays along the printer's axes). three's own
      // position/rotation/scale would scale first, which looks wrong on a stretched model.
      const m = d.model;
      const c = new THREE.Vector3(0, 0, m.baseSize.z / 2);
      const turn = new THREE.Matrix4().makeRotationAxis(d.n, THREE.MathUtils.degToRad(deg));
      m.mesh.matrixAutoUpdate = false;
      m.mesh.matrix.makeTranslation(d.startPos.x, d.startPos.y, 0)
        .multiply(new THREE.Matrix4().makeScale(m.mesh.scale.x, m.mesh.scale.y, m.mesh.scale.z))
        .multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z))
        .multiply(turn)
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      m.mesh.matrixWorldNeedsUpdate = true;
      this.requestRender();
    }
    const rect = this.canvas.getBoundingClientRect();
    this.angleLabel.textContent = `${deg}°`;
    this.angleLabel.style.left = `${e.clientX - rect.left + 16}px`;
    this.angleLabel.style.top = `${e.clientY - rect.top - 10}px`;
    this.angleLabel.hidden = false;
  }

  endRingDrag() {
    const d = this.ringDrag;
    this.ringDrag = null;
    this.angleLabel.hidden = true;
    for (const part of Object.values(this.ringParts)) part.vis.material.opacity = 0.95;
    d.model.mesh.matrixAutoUpdate = true;
    d.model.mesh.position.copy(d.startPos);
    d.model.mesh.updateMatrix();
    if (d.snapped % 360 !== 0) this.rotate(d.model, d.axis, d.snapped);
    else this.changed();
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
    this.updateRings();
    this.scheduleTrees();
    this.requestRender();
    this.emit('change');
  }

  // Build missing search trees one model at a time, in idle moments.
  scheduleTrees() {
    if (this.treeQueued) return;
    this.treeQueued = true;
    idle(() => {
      this.treeQueued = false;
      const m = this.models.find(wantsTree);
      if (!m || this.drag || this.ringDrag) {
        if (m) this.scheduleTrees();
        return;
      }
      m.geometry.computeBoundsTree();
      this.scheduleTrees();
    }, { timeout: 2000 });
  }

  // ---- Undo / redo ----------------------------------------------------------------------------
  // Every change to the plate records how to undo and redo itself. Turns are undone with the
  // inverse turn (the shape comes back exactly; only its centring is redone), so big models do not
  // need a copy per step. Removed models stay alive in the history so Undo can bring them back.

  record(entry) {
    if (this.pending) {
      this.pending.push(entry);
      return;
    }
    this.undoStack.push(entry);
    const dropped = this.redoStack;
    if (this.undoStack.length > 60) dropped.push(this.undoStack.shift());
    this.redoStack = [];
    this.release(dropped);
    this.emit('history');
  }

  // History entries that add or remove models list them in `models`. When entries are dropped
  // (redo cleared by a new change, or the oldest undo trimmed), a model that is off the plate and
  // named by no remaining entry can never come back: free its GPU buffers.
  release(entries) {
    const gone = new Set(entries.flatMap((e) => e.models ?? []));
    if (!gone.size) return;
    for (const e of [...this.undoStack, ...this.redoStack]) for (const m of e.models ?? []) gone.delete(m);
    for (const m of gone) {
      if (this.models.includes(m)) continue;
      m.geometry.disposeBoundsTree?.();
      m.geometry.dispose();
      m.material.dispose();
    }
  }

  /** Run fn so that everything it changes is one Undo step. */
  transaction(label, fn) {
    if (this.pending) return fn();
    this.pending = [];
    try {
      return fn();
    } finally {
      const list = this.pending;
      this.pending = null;
      if (list.length === 1) this.record(list[0]);
      else if (list.length) {
        this.record({
          label,
          undo: () => [...list].reverse().forEach((e) => e.undo()),
          redo: () => list.forEach((e) => e.redo()),
          models: list.flatMap((e) => e.models ?? []),
        });
      }
    }
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this.changed();
    this.emit('history');
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this.changed();
    this.emit('history');
    return e.label;
  }

  attach(model, index = this.models.length) {
    model.mesh.visible = this.stage !== 'preview';
    this.models.splice(index, 0, model);
    this.scene.add(model.mesh);
    this.select(model);
  }

  detach(model) {
    const index = this.models.indexOf(model);
    if (index < 0) return -1;
    this.scene.remove(model.mesh);
    this.models.splice(index, 1);
    if (this.selection.has(model)) {
      this.selection.delete(model);
      this.selectMany([...this.selection], [...this.selection].pop() ?? null);
    }
    return index;
  }

  addModel(name, positions) {
    const model = new Model(name, positions);
    this.paint(model);
    this.placeFree(model);
    this.attach(model);
    this.record({ label: `add ${name}`, undo: () => this.detach(model), redo: () => this.attach(model), models: [model] });
    this.changed();
    return model;
  }

  remove(model) {
    if (!model) return;
    const index = this.detach(model);
    if (index < 0) return;
    this.record({ label: `delete ${model.name}`, undo: () => this.attach(model, index), redo: () => this.detach(model), models: [model] });
    this.changed();
  }

  clear() {
    this.transaction('clear the plate', () => {
      for (const m of [...this.models]) this.remove(m);
    });
  }

  duplicate(model) {
    if (!model) return null;
    const copy = new Model(model.name, model.geometry.attributes.position.array.slice());
    copy.original = model.original.slice();
    copy.health = model.health;
    copy.mesh.scale.copy(model.mesh.scale);
    copy.position.copy(model.position);
    this.paint(copy);
    this.placeFree(copy);
    this.attach(copy);
    this.record({ label: `copy ${model.name}`, undo: () => this.detach(copy), redo: () => this.attach(copy), models: [copy] });
    this.changed();
    return copy;
  }

  select(model) {
    this.selectMany(model ? [model] : [], model ?? null);
  }

  /** Ctrl + click: add a model to the selection, or take it out. */
  toggleSelect(model) {
    const next = new Set(this.selection);
    if (next.has(model)) next.delete(model);
    else next.add(model);
    const list = [...next];
    this.selectMany(list, next.has(model) ? model : (list.at(-1) ?? null));
  }

  selectAll() {
    this.selectMany(this.models, this.models.at(-1) ?? null);
  }

  selectMany(models, primary) {
    this.selection = new Set(models);
    this.selected = primary && this.selection.has(primary) ? primary : null;
    for (const m of this.models) this.tint(m);
    this.updateSelectionBox();
    this.updateRings();
    this.requestRender();
    this.emit('select', this.selected);
  }

  /** Selected models in plate order. */
  get selectedList() {
    return this.models.filter((m) => this.selection.has(m));
  }

  tint(model) {
    const mat = model.material;
    mat.color.copy(model.outside ? OUTSIDE_TINT : new THREE.Color(1, 1, 1));
    mat.emissive.set(this.selection.has(model) ? 0x2a1405 : 0x000000);
  }

  // One blue box per selected model (red if it does not fit).
  updateSelectionBox() {
    const list = this.stage === 'preview' ? [] : this.selectedList;
    while (this.selectionBoxes.length < list.length) {
      const b = new THREE.Box3Helper(new THREE.Box3(), 0x2f81f7);
      this.scene.add(b);
      this.selectionBoxes.push(b);
    }
    this.selectionBoxes.forEach((box, i) => {
      const m = list[i];
      box.visible = !!m;
      if (!m) return;
      const s = m.size;
      const p = m.position;
      box.box.min.set(p.x - s.x / 2, p.y - s.y / 2, 0);
      box.box.max.set(p.x + s.x / 2, p.y + s.y / 2, s.z);
      box.material.color.set(m.outside ? 0xe5484d : 0x2f81f7);
    });
  }

  // ---- Actions on every selected model (one Undo step each) ---------------------------------

  forSelected(label, fn) {
    const list = this.selectedList;
    if (!list.length) return;
    this.transaction(label, () => list.forEach(fn));
  }

  /** Slide every selected model together so the group's middle is the bed's middle. */
  centerSelected() {
    const list = this.selectedList;
    if (!list.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of list) {
      const s = m.size;
      minX = Math.min(minX, m.position.x - s.x / 2);
      maxX = Math.max(maxX, m.position.x + s.x / 2);
      minY = Math.min(minY, m.position.y - s.y / 2);
      maxY = Math.max(maxY, m.position.y + s.y / 2);
    }
    const dx = -(minX + maxX) / 2;
    const dy = -(minY + maxY) / 2;
    this.forSelected('center', (m) => this.setPosition(m, Math.round((m.position.x + dx) * 10) / 10, Math.round((m.position.y + dy) * 10) / 10));
  }

  removeSelected() {
    this.forSelected('delete', (m) => this.remove(m));
  }

  duplicateSelected() {
    const copies = [];
    this.forSelected('copy', (m) => copies.push(this.duplicate(m)));
    if (copies.length > 1) this.selectMany(copies, copies.at(-1));
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

  /** placeFree, as one recorded move (for changes after the model is already on the plate). */
  moveToFreeSpot(model) {
    const start = model.position.clone();
    this.placeFree(model);
    const { x, y } = model.position;
    model.position.copy(start);
    this.setPosition(model, x, y);
  }

  /** Tidy every model into rows, biggest first, centred on the bed. */
  arrangeAll() {
    if (!this.models.length) return;
    const before = this.models.map((m) => [m, m.position.x, m.position.y]);
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
    const after = this.models.map((m) => [m, m.position.x, m.position.y]);
    const put = (list) => list.forEach(([m, px, py]) => m.position.set(px, py, 0));
    this.record({ label: 'arrange', undo: () => put(before), redo: () => put(after) });
    this.changed();
  }

  setPosition(model, x, y) {
    const ox = model.position.x;
    const oy = model.position.y;
    if (ox === x && oy === y) return;
    model.position.set(x, y, 0);
    this.record({ label: 'move', undo: () => model.position.set(ox, oy, 0), redo: () => model.position.set(x, y, 0) });
    this.changed();
  }

  /** Move by a few mm (arrow keys). */
  nudge(model, dx, dy) {
    if (!model) return;
    const r = (v) => Math.round(v * 10) / 10;
    this.setPosition(model, r(model.position.x + dx), r(model.position.y + dy));
  }

  /** Scale in percent per axis (100 = as loaded). */
  setScale(model, sx, sy, sz) {
    const before = model.mesh.scale.clone();
    const after = new THREE.Vector3(sx / 100, sy / 100, sz / 100);
    const put = (v) => {
      model.mesh.scale.copy(v);
      this.paint(model);
    };
    put(after);
    this.record({ label: 'scale', undo: () => put(before), redo: () => put(after) });
    this.changed();
  }

  // Bake a turn or mirror into the model, recorded for Undo as its inverse.
  turn(model, matrix, label) {
    const inverse = matrix.clone().invert();
    const apply = (m) => {
      bake(model, m);
      this.paint(model);
    };
    apply(matrix);
    this.record({ label, undo: () => apply(inverse), redo: () => apply(matrix) });
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
    this.turn(model, m, 'turn');
  }

  mirror(model, axis) {
    const m = new THREE.Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1);
    this.turn(model, m, 'mirror');
  }

  /** Back to how the file loaded: turns and mirrors undone. Scale and position kept. */
  resetTurns(model) {
    const arr = model.geometry.attributes.position.array;
    const before = arr.slice();
    const put = (src) => {
      arr.set(src);
      normalize(model);
      this.paint(model);
    };
    put(model.original);
    this.record({ label: 'undo turns', undo: () => put(before), redo: () => put(model.original) });
    this.changed();
  }

  /** Turn the model so this direction (in model space) points straight down. */
  pointDown(model, normal) {
    const n = normal.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
    this.turn(model, new THREE.Matrix4().makeRotationFromQuaternion(q), 'lay flat');
  }

  /**
   * "Biggest flat side down": group faces by which way they point, add up their area, and put the
   * direction with the most flat area on the bed. Good for Tinkercad-style parts.
   */
  layFlatAuto(model) {
    const p = model.geometry.attributes.position.array;
    // Directions rounded to 1/40 on each axis, packed into one number per bucket.
    const index = new Map();
    const area = [], nx = [], ny = [], nz = [];
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      if (len < 2e-9) continue;
      const key = (Math.round((cx / len) * 40) + 64) * 16384 + (Math.round((cy / len) * 40) + 64) * 128 + (Math.round((cz / len) * 40) + 64);
      let k = index.get(key);
      if (k === undefined) {
        k = area.length;
        index.set(key, k);
        area.push(0); nx.push(0); ny.push(0); nz.push(0);
      }
      area[k] += len / 2;
      nx[k] += cx / 2; // cross/2 = unit normal * triangle area
      ny[k] += cy / 2;
      nz[k] += cz / 2;
    }
    let best = -1;
    for (let k = 0; k < area.length; k++) if (best < 0 || area[k] > area[best]) best = k;
    if (best >= 0) this.pointDown(model, new THREE.Vector3(nx[best], ny[best], nz[best]));
  }

  get supportAngle() {
    return this.supportAngleDeg ?? this.printer.supportAngleDeg;
  }

  /** Faces leaning past this angle from straight up are painted red (they will get support). */
  setSupportAngle(degrees) {
    if (degrees === this.supportAngle) return;
    this.supportAngleDeg = degrees;
    this.overhangCos = Math.cos(THREE.MathUtils.degToRad(90 - degrees));
    for (const m of this.models) this.paint(m);
    this.requestRender();
  }

  startLayFlatPick(on = true) {
    this.layFlatPicking = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    this.emit('layflatpick', on);
  }

  /** Make the model fit inside the bed (with margin), keeping its shape. */
  /** Shrink a model that is too big for the printer (keeping its shape). One that fits is left
   *  alone. `center`: also move it to the middle (not for a group, or they would pile up). */
  scaleToFit(model, { center = true } = {}) {
    const s = model.size;
    const lim = this.limits();
    const fit = Math.min((lim.x * 2) / s.x, (lim.y * 2) / s.y, this.printer.bed.z / s.z);
    const f = fit >= 1 ? 1 : fit * 0.98;
    const sc = model.mesh.scale;
    this.transaction('fit to bed', () => {
      if (f !== 1) this.setScale(model, sc.x * f * 100, sc.y * f * 100, sc.z * f * 100);
      if (center) this.setPosition(model, 0, 0);
    });
  }

  frameSelection() {
    const list = this.selectedList;
    if (!list.length) return this.setView('home');
    const box = new THREE.Box3();
    for (const m of list) {
      const s = m.size;
      box.expandByPoint(new THREE.Vector3(m.position.x - s.x / 2, m.position.y - s.y / 2, 0));
      box.expandByPoint(new THREE.Vector3(m.position.x + s.x / 2, m.position.y + s.y / 2, s.z));
    }
    this.frameBox(box);
  }

  /** Point the camera at a box (world coordinates), keeping the current viewing direction. */
  frameBox(box) {
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 20);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const target = box.getCenter(new THREE.Vector3());
    this.camera.position.copy(target.clone().addScaledVector(dir, r * 3.2));
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  // ---- Pointer ------------------------------------------------------------------------------

  setRay(e) {
    // Positions may have changed since the last frame (Undo, typing a number); picking must use
    // where the models are now, not where they were last drawn.
    this.scene.updateMatrixWorld();
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /**
   * What is under the pointer. `hover`: only for the cursor, so a model still waiting for its
   * search tree counts as hit if the pointer is over its box (never slow).
   */
  pick(e, { hover = false } = {}) {
    this.setRay(e);
    const box = new THREE.Box3();
    const candidates = this.models.filter((m) => {
      box.copy(m.geometry.boundingBox).applyMatrix4(m.mesh.matrixWorld);
      return this.raycaster.ray.intersectsBox(box);
    });
    if (hover) {
      // Box answer for models without a tree, a real test for the rest (fast either way).
      const boxOnly = candidates.find((m) => !m.geometry.boundsTree);
      if (boxOnly) return { model: boxOnly };
    }
    this.raycaster.firstHitOnly = true;
    const hit = this.raycaster.intersectObjects(candidates.map((m) => m.mesh), false)
      .sort((a, b) => a.distance - b.distance)[0];
    return hit ? { model: hit.object.userData.model, point: hit.point, face: hit.face } : null;
  }

  groundPoint(e, z) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  /** True while a model or a rotate ring is being dragged: plate keys must wait. */
  get busy() {
    return !!(this.drag || this.ringDrag);
  }

  onPointerDown(e) {
    if (this.busy) {
      // A second finger (touch screen) while dragging: ignore it, or the drag would restart
      // without recording the first move.
      e.stopImmediatePropagation();
      return;
    }
    this.down = { x: e.clientX, y: e.clientY };
    if (this.stage === 'preview') return; // the camera still works; models cannot be touched
    if (e.button !== 0 || e.shiftKey) return; // right-drag and Shift + drag pan the camera
    if (!this.layFlatPicking && !(e.ctrlKey || e.metaKey)) {
      const axis = this.hitRing(e);
      if (axis && this.startRingDrag(e, axis)) {
        e.stopImmediatePropagation();
        this.down = null;
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
    }
    const hit = this.pick(e);
    if ((e.ctrlKey || e.metaKey) && !this.layFlatPicking) {
      // Ctrl + click on a model adds it to the selection; Ctrl + drag on empty space pans.
      if (!hit) return;
      e.stopImmediatePropagation();
      this.down = null;
      this.toggleSelect(hit.model);
      return;
    }
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
    // Grabbing one of several selected models drags them all.
    if (this.selection.has(hit.model)) this.selectMany([...this.selection], hit.model);
    else this.select(hit.model);
    const ground = this.groundPoint(e, hit.point.z);
    if (!ground) return;
    this.drag = {
      model: hit.model,
      models: this.selectedList.map((m) => ({ m, start: m.position.clone() })),
      ground,
      z: hit.point.z,
      moved: false,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grabbing';
  }

  onPointerMove(e) {
    if (this.ringDrag) {
      this.moveRingDrag(e);
      return;
    }
    if (this.drag) {
      const g = this.groundPoint(e, this.drag.z);
      if (!g) return;
      // Allowed off the bed (it turns grey), but not so far it gets lost.
      const reach = this.printer.bed.x / 2 + 80;
      const clamp = (v) => Math.max(-reach, Math.min(reach, Math.round(v * 10) / 10));
      const dx = g.x - this.drag.ground.x;
      const dy = g.y - this.drag.ground.y;
      for (const { m, start } of this.drag.models) {
        m.position.set(clamp(start.x + dx), clamp(start.y + dy), 0);
        this.checkFit(m);
      }
      this.drag.moved = true;
      this.updateSelectionBox();
      this.updateRings();
      this.requestRender();
      this.emit('dragging', this.drag.model);
      return;
    }
    if (this.layFlatPicking || e.buttons || this.stage === 'preview') return;
    // Hover cursor, at most every 80 ms: raycasting a big model on every mouse move is slow.
    const now = performance.now();
    if (now - (this.lastHover ?? 0) < 80) return;
    this.lastHover = now;
    const ring = this.hitRing(e);
    this.canvas.style.cursor = ring ? 'alias' : this.pick(e, { hover: true }) ? 'grab' : '';
  }

  onPointerUp(e) {
    if (this.ringDrag) {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      this.endRingDrag();
      return;
    }
    if (this.drag) {
      const { moved, models } = this.drag;
      this.drag = null;
      this.canvas.style.cursor = 'grab';
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      if (moved) {
        // One Undo step for the whole drag, however many models moved.
        this.transaction('move', () => {
          for (const { m, start } of models) {
            const { x, y } = m.position;
            m.position.copy(start);
            this.setPosition(m, x, y);
          }
        });
      }
      return;
    }
    if (this.stage === 'preview') return;
    // A plain click (not a camera drag, not Ctrl/Shift) on empty space clears the selection.
    const plain = !(e.ctrlKey || e.metaKey || e.shiftKey);
    if (plain && this.down && e.button === 0 && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
      if (!this.pick(e)) this.select(null);
    }
    this.down = null;
  }

  // ---- Saving the plate in the browser (plate-store.js) --------------------------------------

  /** Everything needed to rebuild the plate: shapes (with turns baked in), originals, scale, place. */
  snapshot() {
    return this.models.map((m) => ({
      name: m.name,
      positions: m.geometry.attributes.position.array.slice(),
      original: m.original,
      scale: [m.mesh.scale.x, m.mesh.scale.y, m.mesh.scale.z],
      position: [m.position.x, m.position.y],
    }));
  }

  /** Put saved models back. Not an Undo step: the history starts fresh. */
  restore(items) {
    for (const it of items) {
      const m = new Model(it.name, it.positions);
      m.original = it.original;
      m.mesh.scale.set(...it.scale);
      m.position.set(it.position[0], it.position[1], 0);
      this.paint(m);
      m.mesh.visible = this.stage !== 'preview';
      this.models.push(m);
      this.scene.add(m.mesh);
    }
    this.undoStack = [];
    this.redoStack = [];
    this.select(null);
    this.changed();
    this.emit('history');
  }

  // ---- Preview: G-code layers ---------------------------------------------------------------
  // One thick-line object per line type (outer wall, infill, ...). All of a type's lines are in one
  // buffer in layer order, so showing layers 0..n is just "draw the first k lines".

  setPreview(parsed) {
    this.clearPreview();
    const group = new THREE.Group();
    // G-code is in printer coordinates (front-left = 0,0); the bed is drawn centred on 0,0.
    group.position.set(-this.printer.bed.x / 2, -this.printer.bed.y / 2, 0);
    this.previewParts = parsed.types.map((t, i) => {
      if (!t.segments.length) return null;
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(t.segments);
      const material = new LineMaterial({ color: LINE_TYPES[i].color, linewidth: 2.2 });
      const lines = new LineSegments2(geometry, material);
      lines.frustumCulled = false;
      group.add(lines);
      return { lines, geometry, material, layerStart: t.layerStart };
    });
    this.preview = parsed;
    this.previewGroup = group;
    group.visible = this.stage === 'preview';
    this.scene.add(group);
    this.setPreviewLayer(parsed.layers.length - 1);
    // Zoom to the printed part (G-code coordinates shifted to the centred bed).
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const t of parsed.types) {
      const a = t.segments;
      for (let i = 0; i < a.length; i += 3) box.expandByPoint(v.set(a[i], a[i + 1], a[i + 2]));
    }
    if (!box.isEmpty()) {
      box.min.z = 0;
      box.translate(group.position);
      this.frameBox(box);
    }
  }

  clearPreview() {
    if (!this.previewGroup) return;
    this.scene.remove(this.previewGroup);
    for (const p of this.previewParts) {
      if (!p) continue;
      p.geometry.dispose();
      p.material.dispose();
    }
    this.previewGroup = null;
    this.previewParts = [];
    this.preview = null;
    this.requestRender();
  }

  /** Show layers 0..n (n counts from 0). */
  setPreviewLayer(n) {
    if (!this.preview) return;
    const last = this.preview.layers.length - 1;
    this.previewLayer = Math.max(0, Math.min(last, Math.round(n)));
    for (const p of this.previewParts) {
      if (p) p.geometry.instanceCount = p.layerStart[this.previewLayer + 1] / 6;
    }
    this.requestRender();
  }

  setPreviewTypeVisible(index, visible) {
    const p = this.previewParts?.[index];
    if (p) p.lines.visible = visible;
    this.requestRender();
  }

  /** 'prepare' shows the models and tools; 'preview' shows the G-code lines instead. */
  setStage(stage) {
    this.stage = stage;
    const preview = stage === 'preview';
    for (const m of this.models) m.mesh.visible = !preview;
    if (this.previewGroup) this.previewGroup.visible = preview;
    for (const b of this.selectionBoxes) b.visible = !preview && b.visible;
    if (preview) this.rings.visible = false;
    else {
      this.updateSelectionBox();
      this.updateRings();
    }
    this.requestRender();
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
