// Metrics (R13) — computed only from the schedule result (tracks, taskLog, slotLog, stageLog,
// lineage). Same source as the animation (R3). Pure.
import { DAY, shiftSeconds } from './schedule.js';

export const BOTTLENECK = 0.85;
const clip = (a, b) => Math.max(0, Math.min(b, DAY) - Math.max(a, 0));

/** busy seconds of one track inside the day (move + work; idle gaps excluded). */
function busy(track) {
  let s = 0;
  for (const g of track.segs) s += clip(g.t0, g.t1);
  return s;
}

function distance(track) {
  let empty = 0, loaded = 0;
  for (const g of track.segs) if (g.type === 'move') (g.carry ? (loaded += g.len) : (empty += g.len));
  return { empty, loaded, total: empty + loaded };
}

/** Pack stations: the process utilization is the busiest station (bottleneck station). */
const PACK_STATIONS = [
  { id: 'idLabel', label: 'ID & label', process: 'idLabel' },
  { id: 'inspect', label: 'Inspection', process: 'inspect' },
  { id: 'shrink', label: 'Shrink wrap', machines: /^SHR-/ },
  { id: 'stuff', label: 'Stuff · palletize · band', process: 'stuff' },
];

export function computeMetrics(R) {
  const res = R.resources;
  // ---- utilization & distance per resource ----
  const perRes = {};
  for (const [id, tr] of Object.entries(R.tracks)) {
    const r = res[id];
    const avail = r.type === 'machine' || r.shift === 'all' ? DAY : shiftSeconds(r.shift);
    const b = busy(tr);
    perRes[id] = {
      id, name: r.name, role: r.role, group: r.group, type: r.type, process: r.process, shift: r.shift,
      busy: b, available: avail, util: avail ? b / avail : 0, distance: distance(tr),
      tasks: R.taskLog.filter((x) => x.res === id).length,
    };
  }

  // ---- packing stations ----
  const stations = PACK_STATIONS.map((st) => {
    const ids = Object.keys(R.tracks).filter((id) => (st.machines ? st.machines.test(id) : res[id].process === st.process));
    const b = ids.reduce((s, id) => s + perRes[id].busy, 0);
    const cap = st.machines ? ids.length * DAY : DAY; // one person per shift covers the whole day
    return { id: st.id, label: st.label, resources: ids, util: cap ? b / cap : 0 };
  });
  const packingUtilization = Math.max(...stations.map((s) => s.util));
  const packingBottleneck = stations.reduce((m, s) => (s.util > m.util ? s : m), stations[0]);

  // ---- throughput ----
  const units = [...R.lineage.units.values()];
  const dailyThroughput = units.filter((u) => u.kind === 'largeBox' && u.attrs.bandedAt !== undefined && u.attrs.bandedAt <= DAY).length;
  const rmConsumed = units.filter((u) => u.kind === 'rmPallet' && u.attrs.consumedAt !== undefined && u.attrs.consumedAt <= DAY).length;

  // ---- staging dwell (put -> pick pairs that closed today) ----
  const groups = {};
  for (const p of R.stageLog) {
    if (p.tOut === null || p.tOut > DAY) continue;
    (groups[p.group] ||= []).push(p.tOut - p.tIn);
  }
  const dwellByGroup = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, {
    n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v),
  }]));
  const allPairs = Object.values(groups).flat();
  const stagingDwellAvg = allPairs.length ? allPairs.reduce((a, b) => a + b, 0) / allPairs.length : 0;

  // ---- hourly workload: task starts per hour (worker tasks >= 3 s) ----
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const x of R.taskLog) {
    if (x.t0 < 0 || x.t0 >= DAY) continue;
    if (res[x.res].type === 'worker' && x.t1 - x.t0 < 3) continue;
    hourly[Math.floor(x.t0 / 3600)]++;
  }

  // ---- concurrent moves: max moving resources in any 30 s window ----
  const W = 30;
  const counts = new Map();
  for (const tr of Object.values(R.tracks)) {
    const seen = new Set();
    for (const g of tr.segs) {
      if (g.type !== 'move') continue;
      for (let w = Math.max(0, Math.floor(g.t0 / W)); w <= Math.min(DAY / W - 1, Math.floor((g.t1 - 1e-9) / W)); w++) seen.add(w);
    }
    for (const w of seen) counts.set(w, (counts.get(w) || 0) + 1);
  }
  let concurrentMax = 0, concurrentAt = 0;
  for (const [w, c] of counts) if (c > concurrentMax || (c === concurrentMax && w * W < concurrentAt)) { concurrentMax = c; concurrentAt = w * W; }

  // ---- slots: pick/put frequency, cube ----
  const freq = new Map();
  for (const e of R.slotLog) {
    const f = freq.get(e.slot) || { puts: 0, picks: 0 };
    if (e.d > 0) f.puts++; else f.picks++;
    freq.set(e.slot, f);
  }
  const cube = cubeByZone(R);

  const bottlenecks = [
    ...Object.values(perRes).filter((r) => r.util > BOTTLENECK).map((r) => ({ kind: 'resource', id: r.id, label: r.name, util: r.util })),
    ...stations.filter((s) => s.util > BOTTLENECK).map((s) => ({ kind: 'station', id: s.id, label: s.label, util: s.util })),
  ].sort((a, b) => b.util - a.util);

  return {
    core: { packingUtilization, dailyThroughput, stagingDwellAvg },
    packingBottleneck: packingBottleneck.id,
    stations, perRes, rmConsumed, dwellByGroup, hourly, concurrentMax, concurrentAt, freq, cube, bottlenecks,
    backlog: R.backlog.length,
  };
}

/** Occupancy of a zone at time t: occupied positions / all positions (clamped 0–1). */
export function occupancyAt(R, zone, t) {
  const zs = R.slots.filter((s) => s.zone === zone);
  if (!zs.length) return null;
  const set = new Set(zs.map((s) => s.id));
  let n = 0;
  for (const id of R.initialOcc.keys()) if (set.has(id)) n++;
  for (const e of R.slotLog) { if (e.t > t) break; if (set.has(e.slot)) n += e.d; }
  return Math.min(1, Math.max(0, n / zs.length));
}

/** Occupied slot ids at time t (for the 3D heat map and static pallets). */
export function occupiedAt(R, t) {
  const occ = new Set(R.initialOcc.keys());
  for (const e of R.slotLog) { if (e.t > t) break; if (e.d > 0) occ.add(e.slot); else occ.delete(e.slot); }
  return occ;
}

function cubeByZone(R) {
  // pallet volume / slot volume, per zone (static geometry; same for every occupied slot)
  const pal = 1.2 * 1.0 * 1.2;
  const out = {};
  for (const s of R.slots) {
    const v = s.w * s.d * s.h;
    const z = (out[s.zone] ||= { sum: 0, n: 0 });
    z.sum += Math.min(1, pal / v); z.n++;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.sum / v.n]));
}

/** Next task start for a resource after t (S3 "next task at"). */
export function nextTaskAt(R, resId, t) {
  const x = R.taskLog.find((e) => e.res === resId && e.t0 > t);
  return x ? x.t0 : null;
}
