// Geometry (pure): slot enumeration + location codes, solids, dock points, corridor router (R8).
export const pad = (n, w) => String(n).padStart(w, '0');
const EPS = 1e-6;

export function rackType(L, row) {
  return { ...L.defaults.rackTypes[row.type], ...(row.override || {}) };
}

export function rackRect(L, row) {
  const rt = rackType(L, row);
  const [x0, z0] = row.origin;
  return row.along === 'x'
    ? [x0, z0, x0 + rt.bayWidth * row.bays, z0 + rt.depth]
    : [x0, z0, x0 + rt.depth, z0 + rt.bayWidth * row.bays];
}

export function floorRect(f) {
  const [x0, z0] = f.origin, [px, pz] = f.pitch, [w, d] = f.slot;
  return [x0, z0, x0 + px * (f.cols - 1) + w, z0 + pz * (f.rows - 1) + d];
}

/**
 * Every storage position with its location code.
 * Rack: AREA-RR-BB-L-P (bay 01 = end nearest the cross corridor, position counted
 * from the left as seen from the aisle). Floor: LABEL-CC-RR.
 * ap = approach point (where a forklift stands to pick/put).
 */
export function enumerateSlots(L) {
  const aw = L.defaults.global.aisleWidth;
  const slots = [];
  for (const row of L.rackRows) {
    if (row.along !== 'x') throw new Error(`rack row ${row.id}: along '${row.along}' not supported`);
    const rt = rackType(L, row);
    const [x0, z0, x1, z1] = rackRect(L, row);
    const sw = rt.bayWidth / rt.palletsPerBay;
    const zc = (z0 + z1) / 2;
    const az = row.face === 'S' ? z0 - aw / 2 : z1 + aw / 2;
    for (let b = 1; b <= row.bays; b++) {
      const bx0 = row.bay01 === 'east' ? x1 - b * rt.bayWidth : x0 + (b - 1) * rt.bayWidth;
      const bx1 = bx0 + rt.bayWidth;
      for (let lv = 1; lv <= rt.levels; lv++) {
        for (let i = 1; i <= rt.palletsPerBay; i++) {
          // facing north from a south aisle, left = west; facing south from a north aisle, left = east
          const x = row.face === 'S' ? bx0 + (i - 0.5) * sw : bx1 - (i - 0.5) * sw;
          slots.push({
            id: `${row.area}-${pad(row.row, 2)}-${pad(b, 2)}-${lv}-${i}`, kind: 'rack', zone: row.zone,
            row: row.id, bay: b, level: lv, pos: i, x, z: zc, y: (lv - 1) * rt.beamPitch,
            ap: [x, az], w: sw, d: rt.depth, h: rt.beamPitch, items: row.items, fill: row.fill,
          });
        }
      }
    }
  }
  for (const f of L.floors) {
    const [ox, oz] = f.origin, [px, pz] = f.pitch, [w, d] = f.slot;
    for (let r = 1; r <= f.rows; r++) {
      for (let c = 1; c <= f.cols; c++) {
        const x = ox + (c - 1) * px + w / 2, z = oz + (r - 1) * pz + d / 2;
        slots.push({
          id: `${f.label}-${pad(c, 2)}-${pad(r, 2)}`, kind: 'floor', zone: f.zone, row: f.id, bay: c, level: 1, pos: r,
          x, z, y: 0, ap: [x, z], w, d, h: L.defaults.global.pallet.h + 0.3, items: null, fill: f.fill,
        });
      }
    }
  }
  return slots;
}

export function solids(L) {
  return [
    ...L.rackRows.map((r) => ({ id: r.id, rect: rackRect(L, r) })),
    ...L.equipment.map((e) => ({ id: e.id, rect: e.rect })),
  ];
}

/** Dock points: forklift stand point inside the door, truck point outside. */
export function dockPoints(d) {
  const inward = { E: [-1, 0], W: [1, 0], N: [0, -1], S: [0, 1] }[d.dir];
  const [x, z] = d.at;
  return {
    inner: [x + inward[0] * 1.2, z + inward[1] * 1.2],
    truck: [x - inward[0] * 3.5, z - inward[1] * 3.5],
  };
}

/** Does segment a-b pass through the interior of rect r (shrunk by m)? Liang-Barsky. */
export function segHitsRect(a, b, r, m = 0.05) {
  const x0 = r[0] + m, z0 = r[1] + m, x1 = r[2] - m, z1 = r[3] - m;
  if (x0 >= x1 || z0 >= z1) return false;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dz, dz], q = [a[0] - x0, x1 - a[0], a[1] - z0, z1 - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPS) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > EPS;
}

export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const polyLen = (pts) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

export function moduleOf(L, p) {
  for (const m of L.modules) {
    const r = m.rect;
    if (p[0] >= r[0] - EPS && p[0] <= r[2] + EPS && p[1] >= r[1] - EPS && p[1] <= r[3] + EPS && m.id !== 'ROAD') return m.id;
  }
  return 'ROAD';
}

/**
 * Router (R8): straight line when clear; otherwise approach -> nearest reachable
 * corridor -> corridor network (shortest) -> destination approach. Never through racks/equipment.
 */
export function makeRouter(L) {
  const sol = solids(L);
  const clear = (a, b) => !sol.some((s) => segHitsRect(a, b, s.rect));
  const byMod = {};
  for (const c of L.corridors) (byMod[c.module] ||= []).push(c);
  const graphs = {};
  for (const [mod, cs] of Object.entries(byMod)) {
    // node positions per corridor: endpoints + intersections
    const onC = cs.map((c) => {
      const pts = [c.from, c.to];
      for (const o of cs) {
        if (o === c || o.axis === c.axis) continue;
        if (o.at >= c.from - EPS && o.at <= c.to + EPS && c.at >= o.from - EPS && c.at <= o.to + EPS) pts.push(o.at);
      }
      return [...new Set(pts.map((v) => +v.toFixed(3)))].sort((x, y) => x - y);
    });
    const pt = (c, s) => (c.axis === 'x' ? [s, c.at] : [c.at, s]);
    const nodes = new Map(); const adj = new Map();
    const addEdge = (a, b) => {
      const ka = key(a), kb = key(b), w = dist(a, b);
      nodes.set(ka, a); nodes.set(kb, b);
      (adj.get(ka) || adj.set(ka, []).get(ka)).push([kb, w]);
      (adj.get(kb) || adj.set(kb, []).get(kb)).push([ka, w]);
    };
    cs.forEach((c, i) => { for (let j = 1; j < onC[i].length; j++) addEdge(pt(c, onC[i][j - 1]), pt(c, onC[i][j])); });
    graphs[mod] = { cs, onC, pt, nodes, adj };
  }

  function entries(g, p) {
    const out = [];
    g.cs.forEach((c, i) => {
      const s = Math.min(Math.max(c.axis === 'x' ? p[0] : p[1], c.from), c.to);
      const proj = g.pt(c, s);
      if (clear(p, proj)) out.push({ ci: i, s, proj, w: dist(p, proj) });
    });
    return out;
  }

  // Local detour (short walks inside a work cell): p -> one corner of a nearby obstacle
  // (offset 0.4 m) -> q, both legs clear. Longer trips always use the corridors (R8).
  const LOCAL = 15;
  const corners = [];
  for (const s of sol) {
    const [x0, z0, x1, z1] = s.rect, o = 0.4;
    corners.push([x0 - o, z0 - o], [x0 - o, z1 + o], [x1 + o, z0 - o], [x1 + o, z1 + o]);
  }
  const inside = (c) => sol.some((s) => c[0] > s.rect[0] && c[0] < s.rect[2] && c[1] > s.rect[1] && c[1] < s.rect[3]);
  function detour(p, q) {
    let best = null, bl = Infinity;
    for (const c of corners) {
      const l = dist(p, c) + dist(c, q);
      if (l >= bl || l > 2 * LOCAL || inside(c)) continue;
      if (clear(p, c) && clear(c, q)) { best = [p, c, q]; bl = l; }
    }
    return best;
  }

  const cache = new Map();
  function route(p, q) {
    const ck = key(p) + '|' + key(q);
    if (cache.has(ck)) return cache.get(ck);
    let res;
    if (dist(p, q) < EPS) res = [p];
    else if (clear(p, q)) res = [p, q];
    else if (dist(p, q) <= LOCAL && (res = detour(p, q))) { /* short walk around one obstacle corner */ }
    else {
      const mod = moduleOf(L, p);
      const g = graphs[mod];
      if (!g) throw new Error(`route: no corridors in module ${mod}`);
      const ep = entries(g, p), eq = entries(g, q);
      if (!ep.length || !eq.length) throw new Error(`route: no clear corridor access from ${key(p)} or to ${key(q)}`);
      // Dijkstra on graph + virtual S/T and projection nodes
      const D = new Map(), prev = new Map(), done = new Set();
      const extra = new Map(); // key -> [[k,w]]
      const addX = (a, b, w) => { (extra.get(a) || extra.set(a, []).get(a)).push([b, w]); };
      const pos = new Map(g.nodes); pos.set('S', p); pos.set('T', q);
      const link = (e, tag) => {
        const kp = `${tag}${e.ci}`; pos.set(kp, e.proj);
        for (const s of g.onC[e.ci]) { const n = g.pt(g.cs[e.ci], s); addX(kp, key(n), Math.abs(s - e.s)); addX(key(n), kp, Math.abs(s - e.s)); }
        return kp;
      };
      for (const e of ep) { const k = link(e, 'P'); addX('S', k, e.w); }
      for (const e of eq) { const k = link(e, 'Q'); addX(k, 'T', e.w); }
      for (const a of ep) for (const b of eq) if (a.ci === b.ci) addX(`P${a.ci}`, `Q${b.ci}`, Math.abs(a.s - b.s));
      D.set('S', 0);
      while (true) {
        let u = null, best = Infinity;
        for (const [k, v] of D) if (!done.has(k) && v < best) { best = v; u = k; }
        if (u === null || u === 'T') break;
        done.add(u);
        for (const [v, w] of [...(g.adj.get(u) || []), ...(extra.get(u) || [])]) {
          const nd = best + w;
          if (nd < (D.get(v) ?? Infinity) - 1e-9) { D.set(v, nd); prev.set(v, u); }
        }
      }
      if (!D.has('T')) throw new Error(`route: no path ${key(p)} -> ${key(q)}`);
      const path = []; for (let k = 'T'; k; k = prev.get(k)) path.push(pos.get(k));
      path.reverse();
      res = path.filter((x, i) => i === 0 || dist(path[i - 1], x) > EPS);
    }
    cache.set(ck, res);
    return res;
  }
  return { route, clear, solids: sol };
}
