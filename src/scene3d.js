// 3D scene (T6, F-02 / F-05 / F-07). Draws only what the pure modules computed:
// layout (static, thin instances), slot occupancy (SlotOcc), resource tracks (evalTrack),
// loose WIP on tables (wipIntervals). Screen state at t is a pure function of t (R2).
// Uses the global BABYLON from lib/babylon.js (pinned 7.54.3).
import { evalTrack } from './track.js';
import { enumerateSlots, rackRect, rackType, dockPoints } from './geom.js';
import { wipIntervals, wipAt, stackOffsets, SlotOcc, carryOf, UNIT_SIZE } from './scenedata.js';

const B = () => globalThis.BABYLON;

const C = {
  bg: '#0f1620', ground: '#1a2330', road: '#2a3038', roadLine: '#d8c46a',
  wall: '#9fb0c8', floor: { OW: '#2a3444', PA: '#2c3748', ROAD: '#262b33' },
  zone: { ow: '#4f7cac', rcv: '#5aa17f', sto: '#7b6fb0', cell: '#c08a3e', ctx: '#59606b' },
  upright: '#3d6fb6', beam: '#e07b28', palletWood: '#a57b4f', rmLoad: '#d6c29a', fgLoad: '#7fa7d1',
  floorSlot: '#c9d3e0', corridor: '#e8d36a',
  equip: { asrs: '#5d7894', table: '#8c97a6', shrinkWrapper: '#3e9c8f', palletStand: '#6b5a48', bander: '#b0574b', cellLine: '#4a5260' },
  role: { 'Forklift Driver': '#e3a21a', 'Material Handler': '#f08a24', Packer: '#2bb3a3', 'Operations Support': '#a77ce0', 'Shuttle Driver': '#c8ccd4' },
  box: { magazine: '#5f8fd0', smallBox: '#d9b77e', midBox: '#c49a5c', largeBox: '#9fc0e2', rmPallet: '#d6c29a' },
  work: '#ffd24a', marker: '#ffffff',
};

const col3 = (hex) => B().Color3.FromHexString(hex);

function mat(scene, name, hex, { alpha = 1, emissive = 0.0, spec = false } = {}) {
  const m = new (B().StandardMaterial)(name, scene);
  m.diffuseColor = col3(hex);
  if (!spec) m.specularColor = new (B().Color3)(0.05, 0.05, 0.05);
  if (emissive) m.emissiveColor = col3(hex).scale(emissive);
  if (alpha < 1) m.alpha = alpha; // keep back-face culling on: fewer sorting artefacts
  return m;
}

function boxAt(scene, name, rect, y0, h, material, meta) {
  const [x0, z0, x1, z1] = rect;
  const m = B().MeshBuilder.CreateBox(name, { width: x1 - x0, height: h, depth: z1 - z0 }, scene);
  m.position.set((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2);
  m.material = material;
  if (meta) m.metadata = meta;
  return m;
}

/** Thin-instance helper: one mesh, many boxes given as [cx, cy(bottom), cz, sx, sy, sz]. */
function instanced(scene, name, material, boxes, { pickable = false, meta = null } = {}) {
  const BB = B();
  const base = BB.MeshBuilder.CreateBox(name, { size: 1 }, scene);
  base.material = material;
  base.isPickable = pickable;
  if (meta) base.metadata = meta;
  const buf = new Float32Array(16 * Math.max(1, boxes.length));
  const m = new BB.Matrix(), s = new BB.Vector3(), t = new BB.Vector3(), q = BB.Quaternion.Identity();
  boxes.forEach((b, i) => {
    s.set(b[3], b[4], b[5]); t.set(b[0], b[1] + b[4] / 2, b[2]);
    BB.Matrix.ComposeToRef(s, q, t, m); m.copyToArray(buf, i * 16);
  });
  if (!boxes.length) { BB.Matrix.ComposeToRef(new BB.Vector3(0, 0, 0), q, t.set(0, -50, 0), m); m.copyToArray(buf, 0); }
  base.thinInstanceSetBuffer('matrix', buf, 16, true);
  base.alwaysSelectAsActiveMesh = true;
  if (pickable) base.thinInstanceEnablePicking = true;
  base.freezeWorldMatrix();
  return base;
}

/** Dynamic thin-instance pool (WIP boxes, pallets): set(list of [x,yBottom,z,sx,sy,sz,rotY?]). */
class Pool {
  constructor(scene, name, material, cap) {
    const BB = B();
    this.BB = BB; this.cap = cap;
    this.mesh = BB.MeshBuilder.CreateBox(name, { size: 1 }, scene);
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.buf = new Float32Array(16 * cap);
    this.mesh.thinInstanceSetBuffer('matrix', this.buf, 16, false);
    this.mesh.alwaysSelectAsActiveMesh = true;
    this._m = new BB.Matrix(); this._s = new BB.Vector3(); this._t = new BB.Vector3(); this._q = new BB.Quaternion();
    this.n = 0;
    this.set([]);
  }
  set(list) {
    const BB = this.BB;
    if (list.length > this.cap) {
      this.cap = Math.ceil(list.length * 1.5);
      this.buf = new Float32Array(16 * this.cap);
      this.mesh.thinInstanceSetBuffer('matrix', this.buf, 16, false);
    }
    let i = 0;
    for (const b of list) {
      this._s.set(b[3], b[4], b[5]); this._t.set(b[0], b[1] + b[4] / 2, b[2]);
      BB.Quaternion.RotationYawPitchRollToRef(b[6] || 0, 0, 0, this._q);
      BB.Matrix.ComposeToRef(this._s, this._q, this._t, this._m); this._m.copyToArray(this.buf, i * 16); i++;
    }
    this.n = list.length;
    this.mesh.thinInstanceCount = Math.max(0, list.length);
    this.mesh.thinInstanceBufferUpdated('matrix');
    this.mesh.isVisible = list.length > 0;
  }
}

export function createScene(canvas, L, opts = {}) {
  const BB = B();
  if (!BB) throw new Error('3D library not loaded (lib/babylon.js)');
  const engine = new BB.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true }, true);
  const scene = new BB.Scene(engine);
  scene.clearColor = BB.Color4.FromHexString(C.bg + 'ff');
  scene.ambientColor = new BB.Color3(0.25, 0.25, 0.28);
  const hemi = new BB.HemisphericLight('hemi', new BB.Vector3(0.2, 1, -0.3), scene);
  hemi.intensity = 0.85; hemi.groundColor = new BB.Color3(0.25, 0.27, 0.32);
  const sun = new BB.DirectionalLight('sun', new BB.Vector3(-0.4, -1, 0.5), scene);
  sun.intensity = 0.55;

  const site = siteBounds(L);
  const ready = { v: false };
  const st = { R: null, t: 0, slots: enumerateSlots(L), occ: null, occVersion: -1, wip: [], wipKey: '', actors: new Map(), labels: true, onPick: opts.onPick || (() => {}), assumptions: L.assumptions };
  const road = L.modules.find((m) => m.id === 'ROAD');
  st.roadMid = road ? (road.rect[0] + road.rect[2]) / 2 : 0;
  const slotIndex = new Map(st.slots.map((s, i) => [s.id, i]));

  // ---------------- static layout ----------------
  const ground = BB.MeshBuilder.CreateGround('ground', { width: (site[2] - site[0]) + 160, height: (site[3] - site[1]) + 140 }, scene);
  ground.position.set((site[0] + site[2]) / 2, -0.03, (site[1] + site[3]) / 2);
  ground.material = mat(scene, 'm-ground', C.ground);
  ground.metadata = { kind: 'ground' };

  const zoneMeshes = [];
  for (const m of L.modules) {
    const fm = boxAt(scene, `mod-${m.id}`, m.rect, -0.02, 0.04, mat(scene, `m-mod-${m.id}`, C.floor[m.id] || '#2a3444'), { kind: 'module', id: m.id });
    fm.isPickable = true;
    if (m.id === 'ROAD') roadLines(scene, m);
    if (m.wallH > 0) walls(scene, L, m);
  }
  for (const z of L.zones) {
    // zone decal: a single plane above the module floor (a box here z-fights with the floor top)
    const zm = BB.MeshBuilder.CreateGround(`zone-${z.id}`, { width: z.rect[2] - z.rect[0], height: z.rect[3] - z.rect[1] }, scene);
    zm.position.set((z.rect[0] + z.rect[2]) / 2, 0.035, (z.rect[1] + z.rect[3]) / 2);
    zm.material = mat(scene, `m-zone-${z.id}`, C.zone[z.cat] || '#555', { alpha: 0.28 });
    zm.metadata = { kind: 'zone', id: z.id };
    zoneMeshes.push(zm);
    outline(scene, `zl-${z.id}`, z.rect, 0.05, C.zone[z.cat] || '#888', 0.9);
  }
  corridorPaint(scene, L);
  floorSlots(scene, L);
  racks(scene, L);
  const equipMeshes = equipment(scene, L);
  docks(scene, L);

  // pallets in storage (dynamic thin instances, one per occupied slot)
  const palWood = new Pool(scene, 'pal-wood', mat(scene, 'm-palwood', C.palletWood), 2600);
  const palRM = new Pool(scene, 'pal-rm', mat(scene, 'm-palrm', C.rmLoad), 2600);
  const palFG = new Pool(scene, 'pal-fg', mat(scene, 'm-palfg', C.fgLoad), 2600);
  for (const p of [palWood, palRM, palFG]) { p.mesh.isPickable = true; p.mesh.thinInstanceEnablePicking = true; p.mesh.metadata = { kind: 'pallets' }; }
  const palSlotOrder = { wood: [], rm: [], fg: [] };

  // WIP boxes (F-07)
  const wipPools = Object.fromEntries(Object.keys(UNIT_SIZE).map((k) => [k, new Pool(scene, `wip-${k}`, mat(scene, `m-wip-${k}`, C.box[k]), 64)]));
  const yAt = surfaceHeights(L);

  // trace marker (S4/T8): white floor ring pulses + target blinks 0.4 s. Selection: amber ring.
  const marker = BB.MeshBuilder.CreateTorus('marker', { diameter: 2.4, thickness: 0.12, tessellation: 48 }, scene);
  marker.material = mat(scene, 'm-marker', C.marker, { emissive: 1 });
  marker.isPickable = false; marker.isVisible = false;
  const blinkBox = BB.MeshBuilder.CreateBox('trace-blink', { size: 1 }, scene);
  blinkBox.material = mat(scene, 'm-blink', C.marker, { emissive: 0.9, alpha: 0.55 });
  blinkBox.isPickable = false; blinkBox.isVisible = false;
  const selRing = BB.MeshBuilder.CreateTorus('sel-ring', { diameter: 2.0, thickness: 0.1, tessellation: 40 }, scene);
  selRing.material = mat(scene, 'm-sel', '#ffb547', { emissive: 1 });
  selRing.isPickable = false; selRing.isVisible = false;
  // trace: {obj, kind} from the caller for time t (same clock as everything else -> R2/R11)
  const trace = { fn: null, cur: null, pos: null, scale: 1, blinkActor: null, follow: false, onFollowOff: null };
  const sel = { obj: null, pos: null };

  // ---------------- cameras ----------------
  const cams = makeCameras(scene, canvas, site, ground);

  // ---------------- labels (DOM overlay) ----------------
  const labelLayer = opts.labelLayer || null;
  const zoneLabels = [];
  const resLabels = new Map(); // id -> {el}
  if (labelLayer) {
    for (const z of L.zones) {
      const el = document.createElement('div');
      el.className = 'lbl lbl-zone';
      el.textContent = z.name;
      labelLayer.appendChild(el);
      zoneLabels.push({ el, p: new BB.Vector3((z.rect[0] + z.rect[2]) / 2, 0.5, (z.rect[1] + z.rect[3]) / 2) });
    }
  }

  // dragging the view while following a trace hands the camera back to the user
  {
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointermove', (e) => {
      if (!down || !trace.follow || !e.buttons) return;
      if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) { trace.follow = false; if (trace.onFollowOff) trace.onFollowOff(); }
    });
    window.addEventListener('pointerup', () => { down = null; });
  }

  // ---------------- picking ----------------
  scene.onPointerObservable.add((pi) => {
    if (pi.type !== BB.PointerEventTypes.POINTERTAP || pi.event.button !== 0) return;
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m.isPickable && m.isEnabled() && m.isVisible);
    st.onPick(describePick(hit));
  });

  function describePick(hit) {
    if (!hit || !hit.hit) return null;
    let m = hit.pickedMesh;
    while (m && !m.metadata && m.parent) m = m.parent;
    const md = m && m.metadata;
    const p = [hit.pickedPoint.x, hit.pickedPoint.z];
    if (!md) return { kind: 'point', p };
    if (md.kind === 'pallets') {
      const order = m === palWood.mesh ? palSlotOrder.wood : m === palRM.mesh ? palSlotOrder.rm : palSlotOrder.fg;
      const slot = order[hit.thinInstanceIndex];
      return slot ? { kind: 'slot', id: slot, p } : { kind: 'point', p };
    }
    if (md.kind === 'rack') {
      // nearest slot of that rack row to the hit point
      let best = null, bd = Infinity;
      for (const s of st.slots) if (s.row === md.id) { const d = Math.hypot(s.x - p[0], s.z - p[1]) + Math.abs(s.y + 0.6 - hit.pickedPoint.y) * 0.5; if (d < bd) { bd = d; best = s; } }
      return best ? { kind: 'slot', id: best.id, p } : { kind: 'rack', id: md.id, p };
    }
    if (md.kind === 'module' || md.kind === 'ground' || md.kind === 'zone') {
      const z = L.zones.find((zz) => p[0] >= zz.rect[0] && p[0] <= zz.rect[2] && p[1] >= zz.rect[1] && p[1] <= zz.rect[3]);
      return z ? { kind: 'zone', id: z.id, p } : { kind: 'point', p };
    }
    return { ...md, p };
  }

  // ---------------- dynamic state ----------------
  function setResult(R) {
    st.R = R;
    st.occ = new SlotOcc(R);
    st.occVersion = -1;
    st.assumptions = R.assumptions;
    const asrsIn = L.packStations.points.find((p) => p.id === 'asrsIn');
    st.wip = wipIntervals(R, { hide: asrsIn ? [asrsIn.at] : [] });
    st.wipKey = '';
    for (const a of st.actors.values()) a.root.dispose(false, true);
    st.actors.clear();
    for (const l of resLabels.values()) l.el.remove();
    resLabels.clear();
    for (const [id, track] of Object.entries(R.tracks)) {
      const res = R.resources[id];
      if (res.type === 'machine') { st.actors.set(id, { id, res, track, machine: true, mesh: equipMeshes.get(id), root: { dispose() {} } }); continue; }
      st.actors.set(id, buildActor(scene, id, res, track, L));
      if (labelLayer) {
        const el = document.createElement('div');
        el.className = 'lbl lbl-res'; el.textContent = res.name;
        labelLayer.appendChild(el);
        resLabels.set(id, { el });
      }
    }
    trace.blinkActor = null;
    refreshEnabled();
    // inactive equipment (e.g. 2nd shrink wrapper) is drawn faded
    for (const [id, m] of equipMeshes) {
      const active = id !== 'SHR-2' || R.assumptions.packOption === 2;
      m.visibility = active ? 1 : 0.25;
      m.metadata.inactive = !active;
    }
    apply(st.t, true);
  }

  function apply(t, force = false) {
    st.t = t;
    const R = st.R;
    if (!R) return;
    // resources
    let moving = 0, working = 0;
    for (const a of st.actors.values()) {
      const s = evalTrack(a.track, t);
      a.state = s;
      if (!a.machine && s.seg) { if (s.moving) moving++; else working++; }
      if (a.machine) {
        if (a.mesh) a.mesh.material.emissiveColor = s.seg && s.phase === 'work' ? col3(C.work).scale(0.35) : BB.Color3.Black();
        continue;
      }
      a.root.position.x = s.p[0]; a.root.position.z = s.p[1];
      // parked trucks face away from the dock they serve (trailer to the door)
      a.root.rotation.y = a.res.type === 'truck' && !s.moving ? (s.p[0] < st.roadMid ? Math.PI / 2 : -Math.PI / 2) : s.heading;
      setCarry(a, carryOf(R, a.id, s), s);
    }
    st.activity = { moving, working };
    // pallets in slots
    const occ = st.occ.at(t);
    if (force || st.occVersion !== st.occ.version) {
      st.occVersion = st.occ.version;
      const wood = [], rm = [], fg = [];
      palSlotOrder.wood = []; palSlotOrder.rm = []; palSlotOrder.fg = [];
      for (const id of occ) {
        const s = st.slots[slotIndex.get(id)];
        if (!s) continue;
        const y = s.y + (s.kind === 'rack' && s.level > 1 ? 0.06 : 0);
        wood.push([s.x, y, s.z, 1.2, 0.14, 1.0]); palSlotOrder.wood.push(id);
        const fgZone = s.zone === 'PA-FG';
        (fgZone ? fg : rm).push([s.x, y + 0.14, s.z, 1.12, 0.98, 0.95]);
        (fgZone ? palSlotOrder.fg : palSlotOrder.rm).push(id);
      }
      palWood.set(wood); palRM.set(rm); palFG.set(fg);
    }
    // WIP on tables / stands / outfeeds
    const groups = wipAt(st.wip, t);
    let key = '';
    for (const [k, g] of groups) key += k + ':' + g.length + '|';
    if (force || key !== st.wipKey) {
      st.wipKey = key;
      const lists = Object.fromEntries(Object.keys(UNIT_SIZE).map((k) => [k, []]));
      for (const g of groups.values()) {
        const byKind = new Map();
        for (const w of g) (byKind.get(w.kind) || byKind.set(w.kind, []).get(w.kind)).push(w);
        let kx = 0;
        const kinds = [...byKind.keys()];
        for (const kind of kinds) {
          const ws = byKind.get(kind);
          const [w, d, h] = UNIT_SIZE[kind];
          const offs = stackOffsets(kind, ws.length);
          const shift = (kx - (kinds.length - 1) / 2) * 1.0;
          const y0 = yAt(ws[0].p);
          offs.forEach(([dx, dy, dz]) => lists[kind].push([ws[0].p[0] + dx + shift, y0 + dy, ws[0].p[1] + dz, w, h, d]));
          kx++;
        }
      }
      for (const [k, pool] of Object.entries(wipPools)) pool.set(lists[k]);
    }
    updateTargets(t);
  }

  /** World position of a lineage obj at the current state (actors already placed for t). */
  function objPos(obj) {
    if (!obj) return null;
    if (obj.type === 'res') {
      const a = st.actors.get(obj.id);
      if (!a) return null;
      if (a.machine) return a.mesh ? { p: [a.mesh.position.x, a.mesh.position.z], y: 0, res: a } : null;
      return { p: [a.root.position.x, a.root.position.z], y: 0, res: a };
    }
    if (obj.type === 'pal') { const s = st.slots[slotIndex.get(obj.id)]; return s ? { p: [s.x, s.z], y: s.y, slot: s } : null; }
    if (obj.type === 'pt') return { p: [obj.p[0], obj.p[1]], y: yAt(obj.p) };
    return null;
  }

  function updateTargets(t) {
    // trace target
    const cur = trace.fn ? trace.fn(t) : null;
    trace.cur = cur;
    const tp = cur ? objPos(cur.obj) : null;
    trace.pos = tp ? tp.p : null;
    if (trace.blinkActor && (!tp || tp.res !== trace.blinkActor)) { setActorVisible(trace.blinkActor, true); trace.blinkActor = null; }
    if (tp) {
      const truck = tp.res && tp.res.res && tp.res.res.type === 'truck';
      trace.scale = truck ? 4 : (cur.kind === 'rmPallet' || cur.kind === 'largeBox') ? 1.3 : 1;
      marker.position.set(tp.p[0], 0.08, tp.p[1]);
      marker.isVisible = true;
      if (tp.res) { blinkBox.isVisible = false; trace.blinkActor = tp.res.machine ? null : tp.res; trace.blinkBoxOn = false; }
      else {
        const [w, d, h] = UNIT_SIZE[cur.kind] || UNIT_SIZE.smallBox;
        blinkBox.scaling.set(w + 0.12, h + 0.12, d + 0.12);
        blinkBox.position.set(tp.p[0], tp.y + h / 2 + (tp.slot && tp.slot.kind === 'rack' && tp.slot.level > 1 ? 0.06 : 0) + 0.07, tp.p[1]);
        trace.blinkBoxOn = true;
      }
      if (trace.follow) cams.follow(tp.p);
    } else { marker.isVisible = false; blinkBox.isVisible = false; trace.blinkBoxOn = false; }
    // selection ring
    const sp = sel.obj ? objPos(sel.obj) : null;
    sel.pos = sp ? sp.p : null;
    selRing.isVisible = !!sp;
    if (sp) selRing.position.set(sp.p[0], (sp.slot ? sp.y : 0) + 0.1, sp.p[1]);
  }

  function setActorVisible(a, on) {
    for (const m of a.root.getChildMeshes()) if (m !== a.carry) m.isVisible = on;
  }

  // ---------------- layers & flows (F-05) ----------------
  const layerState = { racks: true, pallets: true, wip: true, zones: true, walls: true, equipment: true, resources: true };
  const flowState = { A: true, B: true };
  const layerOf = (name) => {
    if (/^(rack-|rackpick-)/.test(name)) return 'racks';
    if (/^pal-/.test(name)) return 'pallets';
    if (/^wip-/.test(name)) return 'wip';
    if (/^(zone-|zl-|floor-slots|corridor-paint|dock-plates)/.test(name)) return 'zones';
    if (/^(wall-|door-|wl-|wb-)/.test(name)) return 'walls';
    if (/^(eq-|asrs-shelves)/.test(name)) return 'equipment';
    return null;
  };
  const flowOfMesh = (name) => (name === 'pal-rm' || name === 'wip-rmPallet' ? 'A' : name === 'pal-fg' || /^wip-/.test(name) ? 'B' : null);
  function refreshEnabled() {
    for (const m of scene.meshes) {
      const l = layerOf(m.name);
      if (!l) continue;
      const f = flowOfMesh(m.name);
      m.setEnabled(layerState[l] && (!f || flowState[f]));
    }
    for (const a of st.actors.values()) {
      if (a.machine) continue;
      const f = a.res.flow;
      const on = layerState.resources && (!f || flowState[f] !== false);
      a.root.setEnabled(on);
      a.hidden = !on;
    }
  }

  function setCarry(a, c, s) {
    const box = a.carry;
    if (!box) return;
    if (!c) { box.isVisible = false; return; }
    // workers put the box down while they work at a table; it is drawn at the table then (F-07)
    if (a.res.type === 'worker' && !s.moving && s.phase !== 'pick' && s.phase !== 'put') { box.isVisible = false; return; }
    box.isVisible = true;
    const kind = c.kind || a.defaultCarry;
    const [w, d, h] = UNIT_SIZE[kind] || UNIT_SIZE.smallBox;
    if (a.res.type === 'forklift' || a.res.type === 'palletJack') {
      box.scaling.set(1.12, 1.1, 0.95); box.position.set(0, (a.res.type === 'forklift' ? 0.25 : 0.12) + 0.55, a.forkZ);
    } else if (a.res.type === 'worker') {
      box.scaling.set(w, h, d); box.position.set(0, 0.95, 0.42);
    } else if (a.res.type === 'truck') {
      const f = Math.min(1, c.n / 28);
      box.scaling.set(2.3, 2.4, Math.max(0.5, 11.4 * f)); box.position.set(0, 1.25 + 1.2, -2.2 - 11.4 * f / 2);
    } else {
      // carts / AMRs: a block that grows with the count
      const cap = a.res.type === 'flatCart' ? 16 : a.res.type === 'magCart' ? 20 : 8;
      const f = Math.min(1, c.n / cap);
      box.scaling.set(0.9, 0.15 + 0.85 * f, 1.1); box.position.set(0, 0.35 + (0.15 + 0.85 * f) / 2, 0);
    }
  }

  // ---------------- render loop ----------------
  engine.runRenderLoop(() => {
    if (!ready.v) return; // no state updates before the scene is ready (handoff lesson)
    if (opts.beforeFrame) opts.beforeFrame(engine.getDeltaTime() / 1000);
    if (marker.isVisible) {
      const now = performance.now();
      const k = 1 + 0.25 * Math.sin(now / 160);
      marker.scaling.set(k * trace.scale, 1, k * trace.scale);
      const on = Math.floor(now / 400) % 2 === 0; // 0.4 s blink
      blinkBox.isVisible = trace.blinkBoxOn && on;
      if (trace.blinkActor) setActorVisible(trace.blinkActor, on);
    }
    if (selRing.isVisible) selRing.scaling.set(1, 1, 1);
    updateLabels();
    scene.render();
  });
  const onResize = () => { engine.resize(); cams.resize(); };
  window.addEventListener('resize', onResize);

  function updateLabels() {
    if (!labelLayer) return;
    const mode = st.labels === true ? 'zones' : st.labels || 'off';
    labelLayer.style.display = mode === 'off' ? 'none' : '';
    if (mode === 'off') return;
    const cam = scene.activeCamera;
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const vp = cam.viewport.toGlobal(w, h);
    const tm = scene.getTransformMatrix();
    const sx = canvas.clientWidth / w, sy = canvas.clientHeight / h;
    for (const z of zoneLabels) {
      const v = BB.Vector3.Project(z.p, BB.Matrix.IdentityReadOnly, tm, vp);
      const vis = v.z > 0 && v.z < 1 && v.x > -50 && v.x < w + 50 && v.y > -20 && v.y < h + 20;
      z.el.style.display = vis ? '' : 'none';
      if (vis) z.el.style.transform = `translate(${(v.x * sx).toFixed(1)}px, ${(v.y * sy).toFixed(1)}px) translate(-50%, -50%)`;
    }
    const tmp = new BB.Vector3();
    for (const [id, l] of resLabels) {
      const a = st.actors.get(id);
      const show = mode === 'all' && a && !a.hidden;
      if (!show) { l.el.style.display = 'none'; continue; }
      tmp.set(a.root.position.x, a.res.type === 'truck' ? 4.2 : 2.4, a.root.position.z);
      const v = BB.Vector3.Project(tmp, BB.Matrix.IdentityReadOnly, tm, vp);
      const vis = v.z > 0 && v.z < 1 && v.x > -50 && v.x < w + 50 && v.y > -20 && v.y < h + 20;
      l.el.style.display = vis ? '' : 'none';
      if (vis) l.el.style.transform = `translate(${(v.x * sx).toFixed(1)}px, ${(v.y * sy).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  scene.executeWhenReady(() => { ready.v = true; if (opts.onReady) opts.onReady(); });

  return {
    engine, scene,
    setResult,
    setTime: (t) => apply(t),
    get time() { return st.t; },
    setCamera: (mode) => cams.set(mode),
    get cameraMode() { return cams.mode; },
    focus: (p, opt) => cams.focus(p, opt),
    /** 'zones' | 'all' | 'off' (true = 'zones', false = 'off'). */
    setLabels: (mode) => { st.labels = mode === true ? 'zones' : mode === false ? 'off' : mode; },
    set onPick(fn) { st.onPick = fn || (() => {}); },
    setLayer(name, on) { if (!(name in layerState)) throw new Error(`unknown layer ${name}`); layerState[name] = !!on; refreshEnabled(); },
    setFlow(flow, on) { if (!(flow in flowState)) throw new Error(`unknown flow ${flow}`); flowState[flow] = !!on; refreshEnabled(); },
    /** fn(t) -> {obj, kind} | null. Evaluated in the same frame step as the actors (shared clock). */
    setTrace(fn) { trace.fn = fn; updateTargets(st.t); },
    setFollow(on, onOff) { trace.follow = !!on; trace.onFollowOff = onOff || trace.onFollowOff; if (on) updateTargets(st.t); },
    get following() { return trace.follow; },
    traceInfo() { return { cur: trace.cur, markerPos: marker.isVisible ? [marker.position.x, marker.position.z] : null, cameraTarget: cams.target() }; },
    setSelection(obj) { sel.obj = obj; updateTargets(st.t); },
    objPos: (obj) => { const r = objPos(obj); return r ? r.p : null; },
    activity: () => st.activity || { moving: 0, working: 0 },
    /** world position [x, z] of a resource mesh (e2e / trace check). */
    actorPos(id) { const a = st.actors.get(id); if (!a) return null; if (a.machine) return a.mesh ? [a.mesh.position.x, a.mesh.position.z] : null; return [a.root.position.x, a.root.position.z]; },
    actorState(id) { const a = st.actors.get(id); return a ? a.state : null; },
    wipCount() { return Object.values(wipPools).reduce((s, p) => s + p.n, 0); },
    palletCount() { return palWood.n; },
    slots: st.slots,
    dispose() { window.removeEventListener('resize', onResize); engine.dispose(); },
  };
}

// ---------------- builders ----------------
function siteBounds(L) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const m of L.modules) { x0 = Math.min(x0, m.rect[0]); z0 = Math.min(z0, m.rect[1]); x1 = Math.max(x1, m.rect[2]); z1 = Math.max(z1, m.rect[3]); }
  return [x0, z0, x1, z1];
}

function outline(scene, name, r, y, hex, alpha = 1) {
  const BB = B();
  const [x0, z0, x1, z1] = r;
  const l = BB.MeshBuilder.CreateLines(name, { points: [new BB.Vector3(x0, y, z0), new BB.Vector3(x1, y, z0), new BB.Vector3(x1, y, z1), new BB.Vector3(x0, y, z1), new BB.Vector3(x0, y, z0)] }, scene);
  l.color = col3(hex); l.alpha = alpha; l.isPickable = false;
  return l;
}

function walls(scene, L, m) {
  const BB = B();
  const [x0, z0, x1, z1] = m.rect, h = m.wallH, t = 0.25;
  const wm = mat(scene, `m-wall-${m.id}`, C.wall, { alpha: 0.13 });
  const doors = L.docks.filter((d) => d.module === m.id);
  const sides = [
    { dir: 'S', a: [x0, z0], b: [x1, z0] }, { dir: 'N', a: [x0, z1], b: [x1, z1] },
    { dir: 'W', a: [x0, z0], b: [x0, z1] }, { dir: 'E', a: [x1, z0], b: [x1, z1] },
  ];
  for (const s of sides) {
    const along = s.dir === 'S' || s.dir === 'N' ? 0 : 1;
    const lo = s.a[along], hi = s.b[along];
    const cuts = doors.filter((d) => d.dir === s.dir).map((d) => [d.at[along] - d.door / 2, d.at[along] + d.door / 2]).sort((p, q) => p[0] - q[0]);
    let cur = lo;
    const pieces = [];
    for (const [a, b] of cuts) { if (a > cur) pieces.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < hi) pieces.push([cur, hi]);
    for (const [a, b] of pieces) {
      const r = along === 0 ? [a, s.a[1] - t / 2, b, s.a[1] + t / 2] : [s.a[0] - t / 2, a, s.a[0] + t / 2, b];
      const w = boxAt(scene, `wall-${m.id}-${s.dir}-${a}`, r, 0, h, wm);
      w.isPickable = false;
    }
    for (const [a, b] of cuts) { // door header
      const r = along === 0 ? [a, s.a[1] - t / 2, b, s.a[1] + t / 2] : [s.a[0] - t / 2, a, s.a[0] + t / 2, b];
      const w = boxAt(scene, `door-${m.id}-${a}`, r, 4.2, h - 4.2, wm); w.isPickable = false;
    }
  }
  outline(scene, `wl-${m.id}`, m.rect, h, C.wall, 0.5);
  outline(scene, `wb-${m.id}`, m.rect, 0.06, C.wall, 0.8);
}

function roadLines(scene, m) {
  const BB = B();
  const [x0, z0, x1, z1] = m.rect, zc = (z0 + z1) / 2;
  const dashes = [];
  for (let x = x0 + 1; x < x1 - 1; x += 4) dashes.push([x + 1, 0.03, zc, 2, 0.01, 0.2]);
  instanced(scene, 'road-dash', mat(scene, 'm-roaddash', C.roadLine, { emissive: 0.3 }), dashes);
}

function corridorPaint(scene, L) {
  const aw = L.defaults.global.aisleWidth;
  const lines = [];
  for (const c of L.corridors) {
    if (c.module === 'ROAD') continue;
    const main = !/-A\d$/.test(c.id);
    if (!main) continue;
    for (const side of [-1, 1]) {
      const off = side * aw / 2;
      if (c.axis === 'x') lines.push([(c.from + c.to) / 2, 0.045, c.at + off, c.to - c.from, 0.01, 0.1]);
      else lines.push([c.at + off, 0.045, (c.from + c.to) / 2, 0.1, 0.01, c.to - c.from]);
    }
  }
  instanced(scene, 'corridor-paint', mat(scene, 'm-corr', C.corridor, { alpha: 0.55, emissive: 0.2 }), lines);
}

function floorSlots(scene, L) {
  const marks = [];
  for (const f of L.floors) {
    const [ox, oz] = f.origin, [px, pz] = f.pitch, [w, d] = f.slot;
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const x = ox + c * px + w / 2, z = oz + r * pz + d / 2;
      // four thin painted edges per slot
      marks.push([x, 0.05, z - d / 2 - 0.1, w + 0.25, 0.01, 0.06], [x, 0.05, z + d / 2 + 0.1, w + 0.25, 0.01, 0.06]);
      marks.push([x - w / 2 - 0.1, 0.05, z, 0.06, 0.01, d + 0.25], [x + w / 2 + 0.1, 0.05, z, 0.06, 0.01, d + 0.25]);
    }
  }
  instanced(scene, 'floor-slots', mat(scene, 'm-fslot', C.floorSlot, { alpha: 0.7, emissive: 0.2 }), marks);
}

function racks(scene, L) {
  const up = [], beam = [];
  for (const row of L.rackRows) {
    const rt = rackType(L, row);
    const [x0, z0, x1, z1] = rackRect(L, row);
    const H = rt.levels * rt.beamPitch + 0.15;
    for (let b = 0; b <= row.bays; b++) {
      const x = x0 + b * rt.bayWidth;
      up.push([x, 0, z0 + 0.05, 0.09, H, 0.09], [x, 0, z1 - 0.05, 0.09, H, 0.09]);
    }
    for (let lv = 2; lv <= rt.levels + 1; lv++) {
      const y = (lv - 1) * rt.beamPitch - 0.02;
      beam.push([(x0 + x1) / 2, y - 0.1, z0 + 0.05, x1 - x0, 0.12, 0.06], [(x0 + x1) / 2, y - 0.1, z1 - 0.05, x1 - x0, 0.12, 0.06]);
    }
    // invisible pick volume per row (click a rack -> nearest slot)
    const pv = boxAt(scene, `rackpick-${row.id}`, [x0, z0, x1, z1], 0, H, null, { kind: 'rack', id: row.id });
    pv.visibility = 0; pv.isPickable = true;
  }
  instanced(scene, 'rack-uprights', mat(scene, 'm-upright', C.upright), up);
  instanced(scene, 'rack-beams', mat(scene, 'm-beam', C.beam), beam);
}

function equipment(scene, L) {
  const out = new Map();
  for (const e of L.equipment) {
    const hex = C.equip[e.type] || '#777';
    const alpha = e.type === 'asrs' ? 0.55 : e.type === 'cellLine' ? 0.5 : 1;
    const m = boxAt(scene, `eq-${e.id}`, e.rect, 0, e.h, mat(scene, `m-eq-${e.id}`, hex, { alpha }), { kind: 'equipment', id: e.id });
    m.isPickable = true;
    if (e.type === 'asrs') { // internal shelves for a recognisable AS/RS
      const sh = [];
      const [x0, z0, x1, z1] = e.rect;
      for (let y = 1; y < e.h; y += 1.0) sh.push([(x0 + x1) / 2, y, (z0 + z1) / 2, x1 - x0 - 0.4, 0.05, z1 - z0 - 0.4]);
      instanced(scene, `asrs-shelves-${e.id}`, mat(scene, `m-asrs-sh-${e.id}`, '#a9bcd0', { alpha: 0.5 }), sh);
    }
    out.set(e.id, m);
  }
  return out;
}

function docks(scene, L) {
  const plates = [];
  for (const d of L.docks) {
    const p = dockPoints(d);
    const horiz = d.dir === 'E' || d.dir === 'W';
    plates.push([(d.at[0] + p.inner[0]) / 2, 0.02, (d.at[1] + p.inner[1]) / 2, horiz ? 2.2 : d.door, 0.04, horiz ? d.door : 2.2]);
  }
  instanced(scene, 'dock-plates', mat(scene, 'm-dock', '#ffcf3f', { emissive: 0.2 }), plates);
}

/** Height of the surface under a point: table top if inside a table/stand, else floor. */
function surfaceHeights(L) {
  const tops = L.equipment.filter((e) => e.type === 'table' || e.type === 'palletStand');
  return (p) => {
    for (const e of tops) { const r = e.rect; if (p[0] >= r[0] - 1e-6 && p[0] <= r[2] + 1e-6 && p[1] >= r[1] - 1e-6 && p[1] <= r[3] + 1e-6) return e.h; }
    return 0;
  };
}

function buildActor(scene, id, res, track, L) {
  const BB = B();
  const root = new BB.TransformNode(`act-${id}`, scene);
  const meta = { kind: 'resource', id };
  const part = (name, w, h, d, x, y, z, hex, opt) => {
    const m = BB.MeshBuilder.CreateBox(`${id}-${name}`, { width: w, height: h, depth: d }, scene);
    m.position.set(x, y + h / 2, z); m.parent = root; m.material = getMat(scene, hex, opt); m.metadata = meta; m.isPickable = true;
    return m;
  };
  const type = res.type;
  const rt = L.resourceTypes.find((t) => t.id === type);
  const hex = rt ? rt.color : '#ccc';
  let forkZ = 0, defaultCarry = 'smallBox';
  if (type === 'forklift') {
    part('body', 1.1, 1.0, 1.9, 0, 0.15, -0.2, hex);
    part('cab', 1.0, 1.1, 0.9, 0, 1.15, -0.45, '#30353d', { alpha: 0.6 });
    part('mastL', 0.08, 2.4, 0.08, -0.4, 0.15, 0.82, '#2f3338'); part('mastR', 0.08, 2.4, 0.08, 0.4, 0.15, 0.82, '#2f3338');
    part('forkL', 0.1, 0.05, 1.1, -0.3, 0.2, 1.4, '#2f3338'); part('forkR', 0.1, 0.05, 1.1, 0.3, 0.2, 1.4, '#2f3338');
    forkZ = 1.45; defaultCarry = 'rmPallet';
  } else if (type === 'palletJack') {
    part('body', 0.7, 0.9, 0.5, 0, 0, -0.35, hex);
    part('handle', 0.08, 0.9, 0.08, 0, 0.9, -0.55, '#2f3338');
    part('forkL', 0.15, 0.08, 1.1, -0.27, 0.02, 0.45, '#2f3338'); part('forkR', 0.15, 0.08, 1.1, 0.27, 0.02, 0.45, '#2f3338');
    forkZ = 0.5; defaultCarry = 'rmPallet';
  } else if (type === 'truck') {
    part('cab', 2.4, 2.8, 2.2, 0, 0.4, 0, hex);
    part('trailer', 2.5, 2.8, 12, 0, 1.0, -8.2, '#e6e9ee', { alpha: 0.35 });
    part('chassis', 2.2, 0.4, 13.5, 0, 0.5, -6.2, '#3a3f47');
    defaultCarry = 'rmPallet';
  } else if (type === 'amr') {
    part('base', 0.8, 0.32, 1.2, 0, 0, 0, hex);
    part('lidar', 0.18, 0.12, 0.18, 0, 0.32, 0.45, '#111');
    defaultCarry = 'magazine';
  } else if (type === 'flatCart' || type === 'magCart') {
    part('deck', 1.0, 0.1, 1.3, 0, 0.25, 0, hex);
    for (const [x, z] of [[-0.4, -0.55], [0.4, -0.55], [-0.4, 0.55], [0.4, 0.55]]) part(`w${x}${z}`, 0.1, 0.25, 0.1, x, 0, z, '#222');
    part('handle', 1.0, 0.8, 0.06, 0, 0.35, -0.65, '#2f3338');
    defaultCarry = type === 'flatCart' ? 'smallBox' : 'magazine';
  } else { // worker
    const vest = C.role[res.role] || '#f2f2f2';
    const body = BB.MeshBuilder.CreateCylinder(`${id}-body`, { height: 1.15, diameterTop: 0.42, diameterBottom: 0.34, tessellation: 12 }, scene);
    body.position.y = 0.5 + 0.575; body.parent = root; body.material = getMat(scene, vest); body.metadata = meta;
    const legs = BB.MeshBuilder.CreateCylinder(`${id}-legs`, { height: 0.55, diameter: 0.3, tessellation: 10 }, scene);
    legs.position.y = 0.275; legs.parent = root; legs.material = getMat(scene, '#2c3e57'); legs.metadata = meta;
    const head = BB.MeshBuilder.CreateSphere(`${id}-head`, { diameter: 0.28, segments: 10 }, scene);
    head.position.y = 1.82; head.parent = root; head.material = getMat(scene, '#e9c9a8'); head.metadata = meta;
    const hat = BB.MeshBuilder.CreateCylinder(`${id}-hat`, { height: 0.08, diameter: 0.32, tessellation: 12 }, scene);
    hat.position.y = 1.95; hat.parent = root; hat.material = getMat(scene, '#f5f5f5'); hat.metadata = meta;
    const nose = BB.MeshBuilder.CreateBox(`${id}-nose`, { width: 0.12, height: 0.06, depth: 0.12 }, scene);
    nose.position.set(0, 1.8, 0.14); nose.parent = root; nose.material = getMat(scene, '#c9a98a'); nose.metadata = meta;
  }
  const carry = BB.MeshBuilder.CreateBox(`${id}-carry`, { size: 1 }, scene);
  carry.parent = root; carry.isVisible = false; carry.metadata = meta;
  carry.material = getMat(scene, type === 'truck' ? C.rmLoad : type === 'amr' || type === 'magCart' ? C.box.magazine : C.box.smallBox);
  if (type === 'forklift' || type === 'palletJack') carry.material = getMat(scene, C.rmLoad);
  root.position.set(track.home[0], 0, track.home[1]);
  return { id, res, track, root, carry, forkZ, defaultCarry };
}

const matCache = new WeakMap();
function getMat(scene, hex, opt = {}) {
  let c = matCache.get(scene);
  if (!c) matCache.set(scene, (c = new Map()));
  const k = hex + JSON.stringify(opt);
  if (!c.has(k)) c.set(k, mat(scene, `m-${k}`, hex, opt));
  return c.get(k);
}

// ---------------- cameras (orbit / walk / top) ----------------
function makeCameras(scene, canvas, site, ground) {
  const BB = B();
  const cx = (site[0] + site[2]) / 2, cz = (site[1] + site[3]) / 2;
  const span = Math.max(site[2] - site[0], site[3] - site[1]);

  // Orbit: left-drag pan, right-drag rotate, wheel zoom (TRD 1.5)
  const orbit = new BB.ArcRotateCamera('orbit', -Math.PI / 2 - 0.35, 0.85, span * 0.92, new BB.Vector3(cx, 0, cz), scene);
  // narrow screens (phone portrait): pull back so the whole site fits the width
  const ar0 = scene.getEngine().getAspectRatio(orbit);
  if (ar0 < 1.3) orbit.radius *= Math.min(2.6, 1.3 / Math.max(ar0, 0.3));
  orbit.mapPanning = true;
  orbit.panningSensibility = 25;
  orbit.wheelDeltaPercentage = 0.02;
  orbit.lowerRadiusLimit = 6; orbit.upperRadiusLimit = span * 2.5;
  orbit.upperBetaLimit = Math.PI / 2 - 0.04; orbit.lowerBetaLimit = 0.05;
  orbit.minZ = 0.3; orbit.maxZ = 3000;
  orbit.angularSensibilityX = 600; orbit.angularSensibilityY = 600;
  orbit.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
  orbit.inputs.removeByType('ArcRotateCameraGamepadInput');

  // Walk: eye height 1.7 m, WASD, drag to look, wheel ±2 m (Shift 8 m), double-click to walk
  const walk = new BB.UniversalCamera('walk', new BB.Vector3(cx, 1.7, site[1] - 5), scene);
  walk.inputs.removeByType('FreeCameraGamepadInput');
  walk.inputs.removeByType('FreeCameraTouchInput');
  walk.keysUp = [87]; walk.keysDown = [83]; walk.keysLeft = [65]; walk.keysRight = [68];
  walk.keysUpward = []; walk.keysDownward = []; walk.keysRotateLeft = []; walk.keysRotateRight = [];
  walk.speed = 0.35; walk.angularSensibility = 2500; walk.minZ = 0.1; walk.maxZ = 3000; walk.inertia = 0.6;
  walk.fov = 1.0;

  // Top: orthographic, rotation fixed, drag pan, wheel zoom
  const top = new BB.FreeCamera('top', new BB.Vector3(cx, 400, cz), scene);
  top.rotation.set(Math.PI / 2, 0, 0);
  top.mode = BB.Camera.ORTHOGRAPHIC_CAMERA;
  top.minZ = 1; top.maxZ = 1000;
  top.inputs.clear();
  const topSt = { half: span * 0.55 };
  function topBounds() {
    const ar = scene.getEngine().getAspectRatio(top);
    const h = topSt.half;
    top.orthoTop = h / Math.max(ar, 1e-3) * (ar >= 1 ? 1 : 1);
    // keep metres-per-pixel equal on both axes
    top.orthoLeft = -h; top.orthoRight = h;
    top.orthoTop = h / ar; top.orthoBottom = -h / ar;
  }

  // attachControl(element, noPreventDefault, useCtrlForPanning, panningMouseButton) resets the
  // pan button every time, so it is passed here: left button (0) pans, right rotates.
  const attachOrbit = () => orbit.attachControl(canvas, true, false, 0);
  const st = { mode: 'orbit' };
  scene.activeCamera = orbit;
  attachOrbit();

  // walk: wheel moves along view direction, Shift = 8 m
  const onWheel = (e) => {
    if (st.mode === 'walk') {
      e.preventDefault();
      const step = (e.shiftKey ? 8 : 2) * (e.deltaY < 0 ? 1 : -1);
      const f = walk.getDirection(BB.Axis.Z); f.y = 0; f.normalize();
      walk.position.addInPlace(f.scale(step));
    } else if (st.mode === 'top') {
      e.preventDefault();
      const before = topWorld(e);
      topSt.half = Math.min(span * 1.5, Math.max(4, topSt.half * (e.deltaY < 0 ? 0.88 : 1.14)));
      topBounds();
      const after = topWorld(e);
      top.position.x += before[0] - after[0]; top.position.z += before[1] - after[1];
    }
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function topWorld(e) {
    const r = canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    return [top.position.x + top.orthoLeft + u * (top.orthoRight - top.orthoLeft), top.position.z + top.orthoTop - v * (top.orthoTop - top.orthoBottom)];
  }
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (st.mode === 'top') drag = { x: e.clientX, y: e.clientY, px: top.position.x, pz: top.position.z }; });
  window.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointermove', (e) => {
    if (st.mode !== 'top' || !drag) return;
    const r = canvas.getBoundingClientRect();
    const mppx = (top.orthoRight - top.orthoLeft) / r.width;
    top.position.x = drag.px - (e.clientX - drag.x) * mppx;
    top.position.z = drag.pz + (e.clientY - drag.y) * mppx;
  });

  // walk: double-click a floor point -> walk there (max 200 m, ~9 m/s)
  canvas.addEventListener('dblclick', () => {
    if (st.mode !== 'walk') return;
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground || (m.metadata && (m.metadata.kind === 'module' || m.metadata.kind === 'zone')));
    if (!hit || !hit.hit) return;
    const from = walk.position.clone();
    let to = new BB.Vector3(hit.pickedPoint.x, 1.7, hit.pickedPoint.z);
    const d = BB.Vector3.Distance(from, to);
    if (d > 200) to = from.add(to.subtract(from).normalize().scale(200));
    flyTo(walk, 'position', to, Math.max(0.2, Math.min(200, d) / 9));
  });

  function flyTo(cam, prop, to, sec) {
    scene.stopAnimation(cam);
    const fps = 60;
    const anim = new BB.Animation(`fly-${prop}`, prop, fps, prop === 'radius' ? BB.Animation.ANIMATIONTYPE_FLOAT : BB.Animation.ANIMATIONTYPE_VECTOR3, BB.Animation.ANIMATIONLOOPMODE_CONSTANT);
    anim.setKeys([{ frame: 0, value: cam[prop].clone ? cam[prop].clone() : cam[prop] }, { frame: Math.max(1, Math.round(sec * fps)), value: to }]);
    const ease = new BB.SineEase(); ease.setEasingMode(BB.EasingFunction.EASINGMODE_EASEINOUT); anim.setEasingFunction(ease);
    cam.animations = [anim];
    scene.beginAnimation(cam, 0, Math.max(1, Math.round(sec * fps)), false);
  }

  function set(mode) {
    if (!['orbit', 'walk', 'top'].includes(mode)) throw new Error(`unknown camera mode ${mode}`);
    if (mode === st.mode) return;
    const prev = scene.activeCamera;
    scene.stopAnimation(prev);
    prev.detachControl();
    // carry the point of interest over
    const poi = st.mode === 'orbit' ? orbit.target.clone() : st.mode === 'top' ? new BB.Vector3(top.position.x, 0, top.position.z) : walk.position.clone();
    if (mode === 'orbit') { orbit.target = new BB.Vector3(poi.x, 0, poi.z); attachOrbit(); scene.activeCamera = orbit; }
    if (mode === 'walk') {
      const dir = st.mode === 'orbit' ? orbit.target.subtract(orbit.position) : new BB.Vector3(0, 0, 1);
      dir.y = 0; if (dir.length() < 1e-3) dir.set(0, 0, 1); dir.normalize();
      walk.position = new BB.Vector3(poi.x - dir.x * 12, 1.7, poi.z - dir.z * 12);
      walk.setTarget(new BB.Vector3(poi.x, 1.7, poi.z));
      walk.attachControl(canvas, true); scene.activeCamera = walk;
    }
    if (mode === 'top') { top.position.x = poi.x; top.position.z = poi.z; topBounds(); scene.activeCamera = top; }
    st.mode = mode;
  }

  function focus(p, { radius = 30, sec = 0.8 } = {}) {
    const v = new BB.Vector3(p[0], 0, p[1]);
    if (st.mode === 'orbit') { flyTo(orbit, 'target', v, sec); }
    else if (st.mode === 'top') { top.position.x = p[0]; top.position.z = p[1]; }
    else {
      const dir = walk.getDirection(BB.Axis.Z); dir.y = 0; dir.normalize();
      flyTo(walk, 'position', new BB.Vector3(p[0] - dir.x * 8, 1.7, p[1] - dir.z * 8), sec);
    }
    if (st.mode === 'orbit' && radius) orbit.radius = Math.min(orbit.radius, radius * 3);
  }

  /** Follow a point every frame (trace): exact, no easing, so it matches the shared clock. */
  function follow(p) {
    if (st.mode === 'orbit') {
      if (orbit.animations && orbit.animations.length) { scene.stopAnimation(orbit); orbit.animations = []; }
      orbit.target.set(p[0], 0, p[1]);
    } else if (st.mode === 'top') { top.position.x = p[0]; top.position.z = p[1]; }
    else {
      if (walk.animations && walk.animations.length) { scene.stopAnimation(walk); walk.animations = []; }
      const dir = walk.getDirection(BB.Axis.Z); dir.y = 0; if (dir.length() < 1e-3) dir.set(0, 0, 1); dir.normalize();
      walk.position.set(p[0] - dir.x * 10, 1.7, p[1] - dir.z * 10);
    }
  }
  function target() {
    if (st.mode === 'orbit') return [orbit.target.x, orbit.target.z];
    if (st.mode === 'top') return [top.position.x, top.position.z];
    const dir = walk.getDirection(BB.Axis.Z); dir.y = 0; dir.normalize();
    return [walk.position.x + dir.x * 10, walk.position.z + dir.z * 10];
  }

  topBounds();
  return { set, focus, follow, target, get mode() { return st.mode; }, resize: topBounds, orbit, walk, top };
}
