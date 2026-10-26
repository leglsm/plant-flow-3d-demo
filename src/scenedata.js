// Pure helpers that turn a runDay() result into what the 3D scene draws (T6).
// No 3D library here, so the same code is unit-tested in Node.
//
//  - wipIntervals(R): loose work-in-progress at fixed points (tables, stands, outfeeds, F-07).
//    A unit is drawn at a point from its event with obj.type 'pt' until its next own event,
//    until it is packed into a container, or not at all if that was its last event and it was
//    used up (consumed, or turned into another unit). Same source as the trace (R5, R11).
//  - WipIndex: the intervals active at time t, grouped by point, for stacking.
//  - SlotOcc: occupied slots at t, incremental forward, rebuilt on backward scrub (R2).
import { occupiedAt } from './metrics.js';

export const UNIT_SIZE = {
  // w (x), d (z), h (y) in metres — fictional, display only
  rmPallet: [1.2, 1.0, 1.2],
  magazine: [0.6, 0.35, 0.3],
  smallBox: [0.5, 0.35, 0.3],
  midBox: [0.8, 0.6, 0.45],
  largeBox: [1.2, 1.0, 1.2],
};

const pkey = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

export function wipIntervals(R, { hide = [] } = {}) {
  const hidden = new Set(hide.map(pkey)); // e.g. AS/RS input port: units there are inside the AS/RS
  const out = [];
  for (const u of R.lineage.units.values()) {
    const ev = u.ev;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (!e.obj || e.obj.type !== 'pt' || hidden.has(pkey(e.obj.p))) continue;
      const t0 = e.t;
      let t1;
      if (i + 1 < ev.length) t1 = ev[i + 1].t;
      else if (u.attrs.consumedAt !== undefined || u.to.length || u.attrs.unpackedAt !== undefined) t1 = t0; // used up / emptied here
      else t1 = Infinity;
      // packed into a container: the container is drawn from then on
      for (const iv of u.into) if (iv.t0 >= t0 && iv.t0 < t1) t1 = iv.t0;
      if (t1 <= t0) continue;
      // inside a container for part of the interval -> not drawn on its own
      let segs = [[t0, t1]];
      for (const iv of u.into) {
        const a = iv.t0, b = iv.t1 ?? Infinity;
        segs = segs.flatMap(([s, f]) => {
          if (b <= s || a >= f) return [[s, f]];
          const r = [];
          if (a > s) r.push([s, a]);
          if (b < f) r.push([b, f]);
          return r;
        });
      }
      for (const [s, f] of segs) if (f > s) out.push({ unit: u.id, kind: u.kind, t0: s, t1: f, p: e.obj.p, key: pkey(e.obj.p) });
    }
  }
  out.sort((a, b) => a.t0 - b.t0 || (a.unit < b.unit ? -1 : 1));
  return out;
}

/** Active WIP at t, grouped by point key -> [{unit, kind, p}] in arrival order. */
export function wipAt(intervals, t) {
  const groups = new Map();
  for (const w of intervals) {
    if (w.t0 > t) break;
    if (t >= w.t1) continue;
    let g = groups.get(w.key);
    if (!g) groups.set(w.key, (g = []));
    g.push(w);
  }
  return groups;
}

/**
 * Stack layout for one point: boxes go in a small grid (cols × rows) then up in layers.
 * Returns local offsets [dx, dy, dz] (dy = bottom of the box).
 */
export function stackOffsets(kind, n) {
  const [w, d, h] = UNIT_SIZE[kind] || UNIT_SIZE.smallBox;
  const big = kind === 'rmPallet' || kind === 'largeBox';
  const cols = big ? 1 : 2, rows = big ? 1 : 2, per = cols * rows;
  const out = [];
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / per), k = i % per;
    const c = k % cols, r = Math.floor(k / cols);
    out.push([(c - (cols - 1) / 2) * (w + 0.04), layer * (h + 0.01), (r - (rows - 1) / 2) * (d + 0.04)]);
  }
  return out;
}

/** Occupied slots at t; forward steps are incremental, backward steps rebuild. */
export class SlotOcc {
  constructor(R) { this.R = R; this.reset(); }
  reset() { this.t = -Infinity; this.i = 0; this.set = new Set(this.R.initialOcc.keys()); this.version = 0; }
  at(t) {
    const log = this.R.slotLog;
    if (t < this.t) {
      this.set = occupiedAt(this.R, t);
      this.i = 0;
      while (this.i < log.length && log[this.i].t <= t) this.i++;
      this.t = t; this.version++;
      return this.set;
    }
    let changed = false;
    while (this.i < log.length && log[this.i].t <= t) {
      const e = log[this.i++];
      if (e.d > 0) this.set.add(e.slot); else this.set.delete(e.slot);
      changed = true;
    }
    this.t = t;
    if (changed) this.version++;
    return this.set;
  }
}

/** Carried load shown on a resource at its current segment (null if empty-handed). */
export function carryOf(R, resId, st) {
  const c = st.carry;
  if (c === null || c === undefined || c === 0) return null;
  if (typeof c === 'number') return { n: c, kind: null };
  const u = R.lineage.units.get(c);
  return { n: 1, kind: u ? u.kind : null, unit: c };
}

/** Format seconds-of-day as HH:MM:SS (t may exceed a day only for display of backlog). */
export function hms(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

// ---------------- heat map (F-11) ----------------
/** Sequential single-hue ramp, 7 steps, low -> high. Dark scene: high = light (reads as "more"). */
export const HEAT_RAMP = ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];

/**
 * Per-slot heat value and bin (0–6).
 *  occupancy: rack slots = share of occupied positions in the same bay (all levels) at t;
 *             floor slots = 0 / 1 (occupied at t).
 *  frequency: puts + picks today per slot, binned against the busiest slot (0 stays bin 0).
 * Returns { values: Float64Array, bins: Uint8Array, legend: [{bin, from, to}] }.
 */
export function heatValues(slots, mode, { occ, freq }) {
  const n = slots.length, values = new Float64Array(n), bins = new Uint8Array(n);
  if (mode === 'occupancy') {
    const bay = new Map();
    for (const s of slots) {
      if (s.kind !== 'rack') continue;
      const k = `${s.row}|${s.bay}`;
      const b = bay.get(k) || bay.set(k, { n: 0, o: 0 }).get(k);
      b.n++; if (occ.has(s.id)) b.o++;
    }
    slots.forEach((s, i) => {
      const v = s.kind === 'rack' ? (() => { const b = bay.get(`${s.row}|${s.bay}`); return b.o / b.n; })() : occ.has(s.id) ? 1 : 0;
      values[i] = v; bins[i] = Math.min(6, Math.floor(v * 7));
    });
    const legend = HEAT_RAMP.map((_, b) => ({ bin: b, from: b / 7, to: (b + 1) / 7 }));
    return { values, bins, legend, unit: 'share' };
  }
  if (mode === 'frequency') {
    let max = 0;
    slots.forEach((s, i) => { const f = freq.get(s.id); const v = f ? f.puts + f.picks : 0; values[i] = v; if (v > max) max = v; });
    // log scale: a few floor slots (dock, staging) take hundreds of moves, rack slots 1–4
    const lm = Math.log(max + 1);
    const binOf = (v) => (v <= 0 || max === 0 ? 0 : Math.max(1, Math.min(6, Math.ceil((Math.log(v + 1) / lm) * 6))));
    slots.forEach((s, i) => { bins[i] = binOf(values[i]); });
    const edge = (b) => Math.exp((b / 6) * lm) - 1; // upper value of bin b
    const legend = HEAT_RAMP.map((_, b) => b === 0 ? { bin: 0, from: 0, to: 0 } : { bin: b, from: Math.floor(edge(b - 1)) + 1, to: Math.floor(edge(b)) });
    return { values, bins, legend, unit: 'moves', max, scale: 'log' };
  }
  throw new Error(`unknown heat mode ${mode}`);
}
