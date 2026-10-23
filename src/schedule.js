// One fictional day (00:00–24:00) of Flow A (raw material) and Flow B (finished goods).
// Pure: runDay(layout, assumptionOverrides) -> result. Same input -> same output (R1).
//
// Design
//  - Jobs sit in a time-ordered queue; each job takes the earliest-free eligible resource
//    (R7, R9: start = max(release, tFree), shift-aware) and writes its whole task into that
//    resource's track. Successor jobs are queued at the completion time.
//  - Every movement goes through the corridor router (R8).
//  - The lineage events are written in the same lines that write the track (R5), so the
//    trace target (R11) is exactly where the 3D object is.
//  - Work is never invented (R4): idle resources simply stay where they are.
import { mulberry32 } from './rng.js';
import { enumerateSlots, makeRouter, dockPoints } from './geom.js';
import { makeTrack, pushMove, pushMoveTimed, pushStay, evalTrack } from './track.js';
import { makeIds } from './ids.js';
import { Lineage } from './lineage.js';

export const DAY = 86400;

export const STEPS = {
  A: ['GR at offsite', 'Barcode label', 'Quality hold', 'QI release', 'Offsite putaway', 'Wave pick & stage',
    'Shuttle load', 'In transit', 'Plant unload', 'Move to IQC', 'Lot label & IQC', 'Transfer to available',
    'RM putaway', 'Line feed pick', 'Kitting', 'Production input'],
  B: ['AS/RS discharge', 'ID & label', 'Inspection', 'Shrink wrap', 'Flat cart', 'Mid box (stuffing)',
    'Palletize', 'Large box & banding', 'FG putaway', 'Re-input pick', 'Unpack', 'Magazine load',
    'AMR to AS/RS', 'AS/RS store', 'AMR to next process', 'Next process input'],
};

/** Deep-merge assumption overrides (R15: presets only touch assumptions). */
export function mergeAssumptions(base, over = {}) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (!(k in out)) throw new Error(`unknown assumption key: ${k}`);
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  }
  return out;
}

export function shiftWindows(shift) {
  if (shift === 'A') return [[21600, 64800]];
  if (shift === 'B') return [[0, 21600], [64800, DAY]];
  return [[0, DAY]];
}
export const shiftSeconds = (shift) => shiftWindows(shift).reduce((s, [a, b]) => s + b - a, 0);

function nextInShift(shift, t) {
  const w = shiftWindows(shift);
  for (const [a, b] of w) { if (t < a) return a; if (t < b) return t; }
  return Infinity; // no more shift time today
}

class Heap {
  constructor() { this.a = []; this.seq = 0; }
  push(t, fn, tag) { this.a.push({ t, s: this.seq++, fn, tag }); this.#up(this.a.length - 1); }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; this.#down(0); }
    return top;
  }
  get size() { return this.a.length; }
  #lt(i, j) { const x = this.a[i], y = this.a[j]; return x.t < y.t || (x.t === y.t && x.s < y.s); }
  #up(i) { while (i > 0) { const p = (i - 1) >> 1; if (!this.#lt(i, p)) break; [this.a[i], this.a[p]] = [this.a[p], this.a[i]]; i = p; } }
  #down(i) {
    const n = this.a.length;
    for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < n && this.#lt(l, m)) m = l; if (r < n && this.#lt(r, m)) m = r; if (m === i) return; [this.a[i], this.a[m]] = [this.a[m], this.a[i]]; i = m; }
  }
}

export function runDay(L, overrides = {}) {
  const A = mergeAssumptions(L.assumptions, overrides);
  const level = L.volumes.levels[A.volumeLevel];
  if (!level) throw new Error(`volumeLevel ${A.volumeLevel} not in volumes.levels`);
  const f = level.factor;
  const H = L.defaults.handling;
  const P = L.points;
  const PK = Object.fromEntries(L.packStations.points.map((p) => [p.id, p]));
  const rng = mulberry32(L.meta.seed);
  const ids = makeIds(L.idFormats);
  const lin = new Lineage();
  const router = makeRouter(L);
  const slots = enumerateSlots(L);
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const zoneSlots = {};
  for (const s of slots) (zoneSlots[s.zone] ||= []).push(s);
  const items = L.items;
  const itemByPn = new Map(items.map((i) => [i.pn, i]));
  const rmItems = items.filter((i) => i.kind === 'RM');
  const fgItems = items.filter((i) => i.kind === 'FG');
  const rtype = Object.fromEntries(L.resourceTypes.map((t) => [t.id, t]));
  const eqById = Object.fromEntries(L.equipment.map((e) => [e.id, e]));
  const center = (r) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

  // ---------------- actors ----------------
  const actors = new Map();
  const taskLog = []; // {res, task, t0, t1, kind}
  const gated = (r) => {
    if (!r.presetGated) return true;
    const [k, sub] = r.presetGated.split('.');
    return r.gateIndex <= A[k][sub];
  };
  for (const r of L.resources) {
    if (!gated(r)) continue;
    actors.set(r.id, { res: r, type: rtype[r.type], track: makeTrack(r.id, r.home), pos: [...r.home], tFree: 0, kind: 'resource' });
  }
  const machineIds = ['ASRS-1', 'SHR-1', ...(A.packOption === 2 ? ['SHR-2'] : []), 'BND-1'];
  for (const id of machineIds) {
    const e = eqById[id];
    actors.set(id, { res: { id, name: e.name, role: 'Machine', group: 'Equipment', process: e.type, shift: 'all', zone: e.zone, type: 'machine' },
      type: { speed: 0 }, track: makeTrack(id, center(e.rect)), pos: center(e.rect), tFree: 0, kind: 'machine' });
  }
  const pool = (process) => [...actors.values()].filter((a) => a.kind === 'resource' && a.res.process === process);
  const POOLS = {};
  const getPool = (p) => (POOLS[p] ||= pool(p));

  function assign(process, t) {
    let best = null, bs = Infinity;
    for (const a of getPool(process)) {
      const s = nextInShift(a.res.shift, Math.max(t, a.tFree));
      if (s < bs) { bs = s; best = a; }
    }
    if (!getPool(process).length) throw new Error(`no resource for process ${process}`);
    return { a: best, start: bs }; // start = Infinity -> caller moves the job to the backlog
  }

  const speed = (a, loaded) => (loaded ? a.type.speedLoaded : a.type.speed);
  function move(a, t, to, task, carry, phase = 'travel') {
    const pts = router.route(a.pos, to);
    const t1 = pushMove(a.track, t, pts, speed(a, !!carry), task, phase, carry);
    a.pos = [...to];
    return t1;
  }
  function stay(a, t, dur, task, carry, phase = 'work') {
    return pushStay(a.track, t, dur, a.pos, task, phase, carry);
  }
  const log = (a, task, t0, t1, kind = 'task') => { if (t1 > t0) taskLog.push({ res: a.res.id, task, t0, t1, kind }); a.tFree = Math.max(a.tFree, t1); };

  // ---------------- slots ----------------
  const occ = new Map();         // slotId -> {unit, putAt}
  const reserved = new Set();
  const freeAt = new Map();      // slotId -> time last emptied
  const slotLog = [];            // {slot, t, d:+1|-1, unit}
  const stageLog = [];           // {loc, group, unit, tIn, tOut}
  const STAGE_GROUP = { 'OW-STG': 'Shuttle staging', 'PA-HO': 'Line staging', 'PA-KIT': 'Line staging' };
  const initialOcc = new Map();  // slotId -> {item, unit|null} (static opening stock)

  // opening stock: rack rows by fill; lean items never; process areas start empty
  for (const s of slots) {
    if (s.kind !== 'rack') continue;
    const choices = s.items.filter((pn) => !itemByPn.get(pn).lean);
    if (!choices.length) continue;
    if (rng() < s.fill) {
      const item = choices[(s.bay + s.level + s.pos) % choices.length];
      initialOcc.set(s.id, { item, unit: null });
      occ.set(s.id, { unit: null, item, putAt: -Infinity });
    }
  }

  function freeSlot(zone, t, item) {
    const list = zoneSlots[zone] || [];
    const ok = (s) => !occ.has(s.id) && !reserved.has(s.id) && (freeAt.get(s.id) ?? -Infinity) <= t;
    if (item) {
      // prefer rows that carry the item, lowest level, bay 01 first
      const pref = list.filter((s) => s.items && s.items.includes(item) && ok(s));
      if (pref.length) return pref.sort((a, b) => a.level - b.level || a.bay - b.bay || cmp(a.id, b.id))[0];
    }
    return list.find(ok) || null;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function putSlot(s, unitId, t) {
    reserved.delete(s.id);
    occ.set(s.id, { unit: unitId, item: lin.units.get(unitId).item, putAt: t });
    slotLog.push({ slot: s.id, t, d: 1, unit: unitId });
    if (STAGE_GROUP[s.zone]) stageLog.push({ loc: s.id, group: STAGE_GROUP[s.zone], unit: unitId, tIn: t, tOut: null });
  }
  function takeSlot(s, unitId, t) {
    occ.delete(s.id);
    freeAt.set(s.id, t);
    slotLog.push({ slot: s.id, t, d: -1, unit: unitId });
    if (STAGE_GROUP[s.zone]) {
      const r = stageLog.find((x) => x.loc === s.id && x.unit === unitId && x.tOut === null);
      if (r) r.tOut = t;
    }
  }

  /** Units for opening stock are created on first touch with dummy history (R12). */
  function touchStock(s) {
    const o = occ.get(s.id);
    if (o.unit) return o.unit;
    const inPlant = s.zone === 'PA-RM';
    const id = ids.barcodePrev();
    lin.unit('rmPallet', id, 0, { item: o.item, qty: 1, attrs: { dummy: true } });
    lin.alias(id, id, 'barcode');
    if (inPlant) { const lot = ids.lotRMPrev(); lin.alias(lot, id, 'lot'); }
    lin.ev(id, { t: 0, step: 'Opening stock', tx: 'history omitted · dummy', sys: 'Stock overview', loc: s.id, sloc: inPlant ? 'PA01' : 'OW01', obj: { type: 'pal', id: s.id }, note: 'history omitted · dummy' });
    o.unit = id;
    return id;
  }

  // available stock per zone for picking: slots occupied, not reserved, putAt <= t
  function stockFor(zone, t, item) {
    const out = [];
    for (const s of zoneSlots[zone]) {
      const o = occ.get(s.id);
      if (!o || reserved.has(s.id) || o.putAt > t) continue;
      if (item && o.item !== item) continue;
      out.push(s);
    }
    return out.sort((a, b) => occ.get(a.id).putAt - occ.get(b.id).putAt || cmp(a.id, b.id));
  }

  const ev = (unit, t, step, fields) => lin.ev(unit, { t, step, ...fields });
  const palObj = (s) => ({ type: 'pal', id: s.id });
  const resObj = (a) => ({ type: 'res', id: a.res.id });
  const ptObj = (p) => ({ type: 'pt', p: [...p] });

  /**
   * Forklift / pallet-jack move of one pallet. from/to: {slot} | {pt, obj?} | {truck: actor, p}
   * Writes the track, slot log and the two lineage events (pick, put).
   */
  function palletMove(a, start, unit, from, to, task, pickInfo, putInfo) {
    const H2 = H;
    const fromP = from.slot ? from.slot.ap : from.p;
    const toP = to.slot ? to.slot.ap : to.p;
    let t = move(a, start, fromP, task, null);
    t = stay(a, t, H2.pickSec + (from.slot ? (from.slot.level - 1) * H2.perLevelSec : 0), task, null, 'pick');
    if (from.slot) takeSlot(from.slot, unit, t);
    if (from.truck) from.truck.load = from.truck.load.filter((u) => u !== unit);
    ev(unit, t, pickInfo.step, { tx: pickInfo.tx || '', sys: pickInfo.sys || '', loc: from.slot ? from.slot.id : pickInfo.loc || '', sloc: pickInfo.sloc || '', res: a.res.id, obj: resObj(a) });
    t = move(a, t, toP, task, unit, 'carry');
    t = stay(a, t, H2.putSec + (to.slot ? (to.slot.level - 1) * H2.perLevelSec : 0), task, unit, 'put');
    let obj;
    if (to.slot) { putSlot(to.slot, unit, t); obj = palObj(to.slot); }
    else if (to.truck) { to.truck.load.push(unit); obj = resObj(to.truck); }
    else obj = to.obj || ptObj(to.p);
    ev(unit, t, putInfo.step, { tx: putInfo.tx || '', sys: putInfo.sys || '', loc: to.slot ? to.slot.id : putInfo.loc || '', sloc: putInfo.sloc || '', res: a.res.id, obj });
    log(a, task, start, t);
    return t;
  }

  const Q = new Heap();
  const at = (t, fn, tag = '') => Q.push(t, fn, tag);
  const backlog = [];
  const retry = H.retryMin * 60;

  // ================= Flow A: raw material =================
  const nRM = Math.round(L.volumes.daily.rmPallets * f);
  const nDeliv = Math.ceil(nRM / H.deliveryPallets);
  const delivStart = 40 * 60, delivEnd = 20 * 3600;
  let rmLeft = nRM;
  for (let d = 0; d < nDeliv; d++) {
    const n = Math.min(H.deliveryPallets, rmLeft); rmLeft -= n;
    const item = rmItems[d % rmItems.length].pn;
    const t = delivStart + Math.round(d * (delivEnd - delivStart) / Math.max(1, nDeliv - 1 || 1));
    at(t, (tt) => delivery(tt, item, n), 'delivery');
  }

  function delivery(t, item, n) {
    const free = [];
    for (const s of zoneSlots['OW-RCV']) if (!occ.has(s.id) && !reserved.has(s.id) && (freeAt.get(s.id) ?? -1) <= t) free.push(s);
    if (free.length < n) { at(t + 600, (tt) => delivery(tt, item, n), 'delivery'); return; }
    const po = ids.po(), gr = ids.grDoc();
    let batch = null;
    for (let i = 0; i < n; i++) {
      if (i % L.assumptions.lot.palletsPerBatch === 0) batch = ids.batch();
      const id = ids.barcode();
      const s = free[i];
      lin.unit('rmPallet', id, t, { item, qty: 1, attrs: {} });
      lin.alias(id, id, 'barcode'); lin.alias(po, id, 'po'); lin.alias(gr, id, 'grDoc'); lin.alias(batch, id, 'batch');
      putSlot(s, id, t);
      ev(id, t, 'GR at offsite', { tx: 'GR 101 (PO)', sys: `PO ${po} · GR ${gr} · Batch ${batch}`, loc: s.id, sloc: 'OW01', res: 'supplier', obj: palObj(s) });
      at(t, (tt) => labelOW(tt, id, s), 'labelOW');
    }
  }

  function labelOW(t, unit, s) {
    const { a, start } = assign('ow-label', t);
    if (start >= DAY) return backlog.push({ t, what: 'labelOW', unit });
    let tt = move(a, start, s.ap, 'OW: barcode label');
    tt = stay(a, tt, H.labelSec, 'OW: barcode label');
    ev(unit, tt, 'Barcode label', { tx: 'Label print', sys: `Barcode ${unit}`, loc: s.id, sloc: 'OW01', res: a.res.id, obj: palObj(s) });
    log(a, 'OW: barcode label', start, tt);
    at(tt, (x) => moveToQI(x, unit, s), 'qi');
  }

  function moveToQI(t, unit, from) {
    const to = freeSlot('OW-QI', t);
    if (!to) { at(t + 300, (x) => moveToQI(x, unit, from)); return; }
    const { a, start } = assign('ow-move', t);
    if (start >= DAY) return backlog.push({ t, what: 'moveToQI', unit });
    reserved.add(to.id);
    const end = palletMove(a, start, unit, { slot: from }, { slot: to }, 'OW: move to quality hold',
      { step: 'Quality hold', tx: 'Pick', sloc: 'OW01' }, { step: 'Quality hold', tx: 'Transfer posting (to QI)', sys: 'Stock status QI', sloc: 'QI' });
    at(end + H.qiHoldMin * 60, (x) => {
      ev(unit, x, 'QI release', { tx: 'Usage decision', sys: 'Stock status QI → UR', loc: to.id, sloc: 'OW01', res: 'quality', obj: palObj(to) });
      putawayOW(x, unit, to);
    }, 'qiRelease');
  }

  function putawayOW(t, unit, from) {
    const item = lin.units.get(unit).item;
    const to = freeSlot('OW-STO', t, item);
    if (!to) { at(t + 300, (x) => putawayOW(x, unit, from)); return; }
    const { a, start } = assign('ow-move', t);
    if (start >= DAY) return backlog.push({ t, what: 'putawayOW', unit });
    reserved.add(to.id);
    palletMove(a, start, unit, { slot: from }, { slot: to }, 'OW: putaway',
      { step: 'Offsite putaway', tx: 'TO pick', sloc: 'OW01' }, { step: 'Offsite putaway', tx: 'TO confirm', sys: 'Storage bin', sloc: 'OW01' });
  }

  // ---- shuttle waves ----
  const departs = L.volumes.shuttle.depart;
  const perWave = departs.map((_, i) => Math.floor(nRM / departs.length) + (i < nRM % departs.length ? 1 : 0));
  const trucks = {};
  for (const id of ['TRK-1', 'TRK-2']) {
    const a = actors.get(id);
    const n = id === 'TRK-1' ? 1 : 2;
    const owD = L.docks.find((d) => d.id === `D-OW-${n}`), paD = L.docks.find((d) => d.id === `D-PA-${n}`);
    a.dock = { ow: dockPoints(owD), pa: dockPoints(paD), owId: owD.id, paId: paD.id };
    a.pos = [...a.dock.ow.truck]; a.track.home = [...a.dock.ow.truck];
    a.load = [];
    trucks[id] = a;
  }
  const truckFor = (t) => (t >= 21600 && t < 64800 ? trucks['TRK-1'] : trucks['TRK-2']);
  departs.forEach((dep, k) => { if (perWave[k] > 0) at(Math.max(0, dep - H.waveLeadMin * 60), (t) => wave(t, dep, perWave[k], k), 'wave'); });

  function wave(t, dep, n, k) {
    const avail = stockFor('OW-STO', t);
    const lean = avail.filter((s) => itemByPn.get(occ.get(s.id).item).lean);
    const rest = avail.filter((s) => !itemByPn.get(occ.get(s.id).item).lean);
    const picks = [...lean, ...rest].slice(0, n);
    const w = { dep, k, n: picks.length, staged: [], loaded: 0, lastLoad: 0, truck: truckFor(dep), truckAt: Infinity };
    if (!picks.length) return;
    for (const s of picks) {
      const unit = touchStock(s);
      reserved.add(s.id);
      at(t, (x) => wavePick(x, unit, s, w), 'wavePick');
    }
    // truck positioning at the offsite door
    at(Math.max(0, dep - H.truckLeadMin * 60), (x) => truckToOW(x, w), 'truckArrive');
  }

  function wavePick(t, unit, from, w) {
    const to = freeSlot('OW-STG', t);
    if (!to) { at(t + 120, (x) => wavePick(x, unit, from, w)); return; }
    const { a, start } = assign('ow-move', t);
    if (start >= DAY) return backlog.push({ t, what: 'wavePick', unit });
    reserved.delete(from.id);
    reserved.add(to.id);
    const end = palletMove(a, start, unit, { slot: from }, { slot: to }, 'OW: wave pick & stage',
      { step: 'Wave pick & stage', tx: 'TO pick (STO delivery)', sloc: 'OW01' }, { step: 'Wave pick & stage', tx: 'TO confirm', sys: 'Staging lane', sloc: 'OW-STG' });
    w.staged.push({ unit, slot: to, t: end });
    at(Math.max(end, w.dep - H.truckLeadMin * 60, 0), (x) => loadShuttle(x, unit, to, w), 'load');
  }

  function truckToOW(t, w) {
    const tr = w.truck;
    const s = Math.max(t, tr.tFree);
    let tt = s;
    if (tr.pos[0] > 80) { // truck is still at the plant -> drive back (empty)
      tt = pushMoveTimed(tr.track, s, [tr.pos, tr.dock.ow.truck], L.volumes.shuttle.travelMin * 60, 'Shuttle: return', 'travel', null);
      tr.pos = [...tr.dock.ow.truck];
      log(tr, 'Shuttle: return', s, tt);
    }
    w.truckAt = tt;
    tr.tFree = Math.max(tr.tFree, tt);
  }

  function loadShuttle(t, unit, from, w) {
    if (t < w.truckAt) { at(w.truckAt, (x) => loadShuttle(x, unit, from, w)); return; }
    const { a, start } = assign('ow-move', t);
    if (start >= DAY) return backlog.push({ t, what: 'loadShuttle', unit });
    const end = palletMove(a, start, unit, { slot: from }, { truck: w.truck, p: w.truck.dock.ow.inner }, 'OW: load shuttle',
      { step: 'Shuttle load', tx: 'TO pick', sloc: 'OW-STG' }, { step: 'Shuttle load', tx: 'Load (HU on shuttle)', sys: w.truck.res.name, loc: w.truck.dock.owId, sloc: 'Shuttle' });
    w.loaded++; w.lastLoad = Math.max(w.lastLoad, end);
    if (w.loaded === w.n) at(Math.max(w.dep, w.lastLoad), (x) => depart(x, w), 'depart');
  }

  function depart(t, w) {
    const tr = w.truck;
    const s = Math.max(t, tr.tFree);
    // loading time at the door is the truck's work too
    if (w.truckAt < s) { pushStay(tr.track, w.truckAt, s - w.truckAt, tr.pos, 'Shuttle: loading at door', 'work', tr.load.length); log(tr, 'Shuttle: loading at door', w.truckAt, s); }
    const units = tr.load.slice();
    const st = ids.transfer();
    for (const u of units) {
      lin.alias(st, u, 'sto');
      ev(u, s, 'In transit', { tx: 'STO goods issue 641', sys: `STO ${st}`, loc: tr.dock.owId, sloc: 'In transit', res: tr.res.id, obj: resObj(tr) });
    }
    const dur = L.volumes.shuttle.travelMin * 60;
    const tArr = pushMoveTimed(tr.track, s, [tr.pos, tr.dock.pa.truck], dur, 'Shuttle: transit', 'carry', units.length);
    tr.pos = [...tr.dock.pa.truck];
    log(tr, 'Shuttle: transit', s, tArr);
    for (const u of units) ev(u, tArr, 'In transit', { tx: 'Arrived', sys: 'Plant A gate', loc: tr.dock.paId, sloc: 'In transit', res: tr.res.id, obj: resObj(tr) });
    w.unloaded = 0;
    w.arrive = tArr;
    for (const u of units) at(tArr, (x) => unload(x, u, w), 'unload');
  }

  function unload(t, unit, w) {
    const tr = w.truck;
    const to = freeSlot('PA-DOCK', t);
    if (!to) { at(t + 120, (x) => unload(x, unit, w)); return; }
    const { a, start } = assign('pa-receive', t);
    if (start >= DAY) return backlog.push({ t, what: 'unload', unit });
    reserved.add(to.id);
    const end = palletMove(a, start, unit, { truck: tr, p: tr.dock.pa.inner }, { slot: to }, 'PA: unload shuttle',
      { step: 'Plant unload', tx: 'Unload', loc: tr.dock.paId, sloc: 'In transit' }, { step: 'Plant unload', tx: 'GR 101 (STO)', sys: 'Plant A receipt', sloc: 'PA00' });
    w.unloaded++;
    w.lastUnload = Math.max(w.lastUnload || 0, end);
    if (w.unloaded === w.n) {
      const s0 = w.arrive;
      pushStay(tr.track, s0, w.lastUnload - s0, tr.pos, 'Shuttle: unloading at door', 'work', null);
      log(tr, 'Shuttle: unloading at door', s0, w.lastUnload);
    }
    at(end, (x) => moveToIQC(x, unit, to), 'iqcMove');
  }

  function moveToIQC(t, unit, from) {
    const to = freeSlot('PA-IQC', t);
    if (!to) { at(t + 120, (x) => moveToIQC(x, unit, from)); return; }
    const { a, start } = assign('pa-receive', t);
    if (start >= DAY) return backlog.push({ t, what: 'moveToIQC', unit });
    reserved.add(to.id);
    const end = palletMove(a, start, unit, { slot: from }, { slot: to }, 'PA: move to IQC',
      { step: 'Move to IQC', tx: 'Pick', sloc: 'PA00' }, { step: 'Move to IQC', tx: 'Put (inspection area)', sloc: 'PA-QI' });
    at(end, (x) => iqc(x, unit, to), 'iqc');
  }

  function iqc(t, unit, s) {
    const { a, start } = assign('pa-iqc', t);
    if (start >= DAY) return backlog.push({ t, what: 'iqc', unit });
    let tt = move(a, start, s.ap, 'PA: lot label & IQC');
    tt = stay(a, tt, H.iqcSec, 'PA: lot label & IQC');
    const lot = ids.lotRM();
    lin.alias(lot, unit, 'lot');
    ev(unit, tt, 'Lot label & IQC', { tx: 'Lot label · usage decision', sys: `Lot ${lot}`, loc: s.id, sloc: 'PA-QI', res: a.res.id, obj: palObj(s) });
    const st = ids.transfer();
    lin.alias(st, unit, 'transfer');
    ev(unit, tt, 'Transfer to available', { tx: 'Transfer posting 322', sys: `${st} · QI → UR`, loc: s.id, sloc: 'PA01', res: a.res.id, obj: palObj(s) });
    log(a, 'PA: lot label & IQC', start, tt);
    at(tt, (x) => putawayRM(x, unit, s), 'putawayRM');
  }

  function putawayRM(t, unit, from) {
    const item = lin.units.get(unit).item;
    const to = freeSlot('PA-RM', t, item);
    if (!to) { at(t + 300, (x) => putawayRM(x, unit, from)); return; }
    const { a, start } = assign('pa-receive', t);
    if (start >= DAY) return backlog.push({ t, what: 'putawayRM', unit });
    reserved.add(to.id);
    palletMove(a, start, unit, { slot: from }, { slot: to }, 'PA: RM putaway',
      { step: 'RM putaway', tx: 'TO pick', sloc: 'PA01' }, { step: 'RM putaway', tx: 'TO confirm', sys: 'Storage bin', sloc: 'PA01' });
  }

  // ---- production orders (line feed) ----
  const nOrders = nRM;
  const orderGap = DAY / nOrders;
  const shortages = [];
  for (let k = 0; k < nOrders; k++) {
    const item = rmItems[k % rmItems.length].pn;
    at(Math.round(20 * 60 + k * orderGap), (t) => lineFeed(t, item, t), 'order');
  }

  function lineFeed(t, item, tOrder) {
    const st = stockFor('PA-RM', t, item);
    const zone = A.glSplit ? 'PA-KIT' : 'PA-HO';
    const to = st.length ? freeSlot(zone, t) : null;
    if (!st.length || !to) {
      if (!st.length && !shortages.some((s) => s.tOrder === tOrder && s.item === item)) shortages.push({ item, tOrder });
      at(t + retry, (x) => lineFeed(x, item, tOrder), 'order');
      return;
    }
    const sh = shortages.find((s) => s.tOrder === tOrder && s.item === item);
    if (sh) sh.tFilled = t;
    const from = st[0];
    const unit = touchStock(from);
    const { a, start } = assign('pa-feed', t);
    if (start >= DAY) return backlog.push({ t, what: 'lineFeed', unit });
    reserved.add(from.id); reserved.add(to.id);
    reserved.delete(from.id);
    const end = palletMove(a, start, unit, { slot: from }, { slot: to }, 'PA: line feed',
      { step: 'Line feed pick', tx: 'TO pick (production supply)', sloc: 'PA01' },
      { step: 'Line feed pick', tx: 'TO confirm', sys: A.glSplit ? 'Kitting area' : 'Line handover', sloc: 'PSA' });
    at(end, (x) => handover(x, unit, to), 'handover');
  }

  function handover(t, unit, s) {
    const { a, start } = assign('pa-handover', t);
    if (start >= DAY) return backlog.push({ t, what: 'handover', unit });
    const kit = A.manualKitting ? H.kitManualSec : A.glSplit ? H.kitSplitSec : H.kitStdSec;
    const kitTask = A.manualKitting ? 'Kitting (manual)' : A.glSplit ? 'Kitting (kitting area)' : 'Kitting';
    let tt = move(a, start, s.ap, kitTask);
    tt = stay(a, tt, kit, kitTask);
    ev(unit, tt, 'Kitting', { tx: kitTask, sys: s.zone === 'PA-KIT' ? 'Kitting area' : 'Line handover', loc: s.id, sloc: 'PSA', res: a.res.id, obj: palObj(s) });
    tt = stay(a, tt, H.pickSec, kitTask, null, 'pick');
    takeSlot(s, unit, tt);
    ev(unit, tt, 'Production input', { tx: 'Pick to line', loc: s.id, sloc: 'PSA', res: a.res.id, obj: resObj(a) });
    tt = move(a, tt, P.lineInput, 'Handover to line', unit, 'carry');
    tt = stay(a, tt, H.lineInputSec, 'Handover to line', unit, 'put');
    ev(unit, tt, 'Production input', { tx: 'GI 261 (to order)', sys: 'Cell line input', loc: 'LINE-1', sloc: 'PROD', res: a.res.id, obj: ptObj(P.lineInput) });
    lin.units.get(unit).attrs.consumedAt = tt;
    log(a, kitTask, start, tt);
  }

  // ================= Flow B: finished goods =================
  const PKG = L.defaults.packing;
  const nMag = Math.round(L.volumes.daily.fgLargeBoxes * PKG.midPerLarge * PKG.smallPerMid * f);
  const discharge0 = 10 * 60, dischargeEnd = DAY - 3600;
  const gap = (dischargeEnd - discharge0) / nMag;
  let fgLot = null, fgLotItem = null, lotCount = 0;
  const ptOf = (eqId) => center(eqById[eqId].rect);
  for (let k = 0; k < nMag; k++) at(Math.round(discharge0 + k * gap), (t) => dischargeMag(t), 'discharge');

  const asrs = actors.get('ASRS-1');
  function dischargeMag(t) {
    const s = Math.max(t, asrs.tFree);
    if (s >= DAY) return backlog.push({ t, what: 'discharge' });
    if (lotCount % L.assumptions.lot.magazinesPerLot === 0) {
      fgLotItem = fgItems[Math.floor(lotCount / L.assumptions.lot.magazinesPerLot) % fgItems.length].pn;
      fgLot = ids.lotFG();
    }
    lotCount++;
    const id = ids.magazine();
    lin.unit('magazine', id, s, { item: fgLotItem, qty: PKG.cellsPerMagazine });
    lin.alias(fgLot, id, 'lot');
    const tt = pushStay(asrs.track, s, PK.discharge.sec, asrs.pos, 'AS/RS: discharge', 'work', null);
    log(asrs, 'AS/RS: discharge', s, tt, 'machine');
    ev(id, tt, 'AS/RS discharge', { tx: 'Retrieve (HU)', sys: `Lot ${fgLot}`, loc: 'ASRS-1', sloc: 'ASRS', res: 'ASRS-1', obj: ptObj(PK.discharge.at) });
    at(tt, (x) => idLabel(x, id), 'idLabel');
  }

  let emptyMags = [];
  function idLabel(t, mz) {
    const { a, start } = assign('idLabel', t);
    if (start >= DAY) return backlog.push({ t, what: 'idLabel', unit: mz });
    const task = 'Pack: ID & label';
    let tt = move(a, start, PK.discharge.at, task);
    tt = stay(a, tt, H.dropSec, task, null, 'pick');
    ev(mz, tt, 'ID & label', { tx: 'Pick from AS/RS port', loc: 'ASRS-1', sloc: 'PACK', res: a.res.id, obj: resObj(a) });
    tt = move(a, tt, PK.idLabel.at, task, mz, 'carry');
    tt = stay(a, tt, PK.idLabel.sec, task, mz);
    const sbx = ids.smallBox();
    lin.unit('smallBox', sbx, tt, { item: lin.units.get(mz).item, qty: PKG.cellsPerSmall });
    lin.derive(sbx, [mz]);
    const tbl = ptOf('TBL-ID');
    ev(mz, tt, 'ID & label', { tx: 'Cells transferred to small box', sys: `→ ${sbx}`, loc: 'TBL-ID', sloc: 'PACK', res: a.res.id, obj: ptObj(P.emptyMagBuffer) });
    ev(sbx, tt, 'ID & label', { tx: 'Small box ID & label', sys: `from ${mz}`, loc: 'TBL-ID', sloc: 'PACK', res: a.res.id, obj: ptObj(tbl) });
    // hand over to inspection table
    tt = move(a, tt, [PK.inspect.at[0] + 1.6, PK.inspect.at[1]], task, sbx, 'carry');
    tt = stay(a, tt, H.dropSec, task, sbx, 'put');
    ev(sbx, tt, 'Inspection', { tx: 'To inspection', loc: 'TBL-INS', sloc: 'PACK', res: a.res.id, obj: ptObj(ptOf('TBL-INS')) });
    log(a, task, start, tt);
    emptyMags.push(mz);
    if (emptyMags.length >= PKG.emptyMagPerCart) {
      const batch = emptyMags; emptyMags = [];
      at(tt, (x) => amrIn(x, batch, P.emptyMagBuffer, 'empty'), 'amrEmpty');
    }
    at(tt, (x) => inspect(x, sbx), 'inspect');
  }

  function inspect(t, sbx) {
    const { a, start } = assign('inspect', t);
    if (start >= DAY) return backlog.push({ t, what: 'inspect', unit: sbx });
    const task = 'Pack: inspect';
    let tt = move(a, start, PK.inspect.at, task);
    tt = stay(a, tt, PK.inspect.sec, task, sbx);
    ev(sbx, tt, 'Inspection', { tx: 'Inspection pass', loc: 'TBL-INS', sloc: 'PACK', res: a.res.id, obj: ptObj(ptOf('TBL-INS')) });
    tt = move(a, tt, PK.shrink.at, task, sbx, 'carry');
    tt = stay(a, tt, H.dropSec, task, sbx, 'put');
    ev(sbx, tt, 'Shrink wrap', { tx: 'To shrink infeed', loc: 'SHR', sloc: 'PACK', res: a.res.id, obj: ptObj([PK.shrink.at[0], PK.shrink.at[1] - 0.5]) });
    log(a, task, start, tt);
    at(tt, (x) => shrink(x, sbx), 'shrink');
  }

  const shrinkers = machineIds.filter((m) => m.startsWith('SHR')).map((m) => actors.get(m));
  let cartBuf = [];
  const cart = actors.get('FC-1');
  const path = L.packStations.flatCartPath;
  function shrink(t, sbx) {
    // earliest machine, then the shrink operator (loads the box)
    let m = null, ms = Infinity;
    for (const x of shrinkers) { const s = Math.max(t, x.tFree); if (s < ms) { ms = s; m = x; } }
    const { a, start } = assign('shrink', ms);
    if (start >= DAY) return backlog.push({ t, what: 'shrink', unit: sbx });
    const stand = m.res.id === 'SHR-2' ? PK.shrink2.at : PK.shrink.at;
    const task = 'Pack: shrink';
    let tt = move(a, start, stand, task);
    tt = stay(a, tt, H.shrinkLoadSec, 'Pack: load shrink wrapper', sbx);
    log(a, 'Pack: load shrink wrapper', start, tt);
    const mEnd = pushStay(m.track, tt, (m.res.id === 'SHR-2' ? PK.shrink2 : PK.shrink).sec, m.pos, task, 'work', sbx);
    log(m, task, tt, mEnd, 'machine');
    ev(sbx, tt, 'Shrink wrap', { tx: 'Shrink wrap', sys: m.res.id, loc: m.res.id, sloc: 'PACK', res: m.res.id, obj: ptObj(m.pos) });
    ev(sbx, mEnd, 'Flat cart', { tx: 'Shrink outfeed (waiting for cart)', loc: 'SHR', sloc: 'PACK', res: m.res.id, obj: ptObj(path[0]) });
    cartBuf.push(sbx);
    if (cartBuf.length >= PKG.smallPerFlatCart) {
      const batch = cartBuf; cartBuf = [];
      at(mEnd, (x) => cartRun(x, batch), 'cart');
    }
  }

  let stuffBuf = [];
  function cartRun(t, batch) {
    // a full cart leaves only after its last box is on it and the cart is back
    const s = Math.max(t, cart.tFree);
    if (s >= DAY) return backlog.push({ t, what: 'cartRun' });
    const task = 'Pack: flat cart transfer';
    for (const u of batch) ev(u, s, 'Flat cart', { tx: 'Cart to stuffing', loc: 'FC-1', sloc: 'PACK', res: 'FC-1', obj: resObj(cart) });
    let tt = pushMove(cart.track, s, path, cart.type.speedLoaded, task, 'carry', batch.length);
    cart.pos = [...path[path.length - 1]];
    tt = pushStay(cart.track, tt, H.cartUnloadSec, cart.pos, task, 'put', batch.length);
    for (const u of batch) ev(u, tt, 'Mid box (stuffing)', { tx: 'Cart unloaded at stuffing', loc: 'TBL-STF', sloc: 'PACK', res: 'FC-1', obj: ptObj(ptOf('TBL-STF')) });
    const back = [...path].reverse();
    const te = pushMove(cart.track, tt, back, cart.type.speed, task, 'travel', null);
    cart.pos = [...path[0]];
    log(cart, task, s, te);
    for (const u of batch) {
      stuffBuf.push(u);
      if (stuffBuf.length === PKG.smallPerMid) { const four = stuffBuf; stuffBuf = []; at(tt, (x) => stuff(x, four), 'stuff'); }
    }
  }

  let palletMids = [];
  let standFreeAt = 0;
  function stuff(t, four) {
    const { a, start } = assign('stuff', t);
    if (start >= DAY) return backlog.push({ t, what: 'stuff' });
    let tt = move(a, start, PK.stuff.at, 'Pack: stuff mid box');
    tt = stay(a, tt, PK.stuff.sec, 'Pack: stuff mid box');
    const mbx = ids.midBox();
    lin.unit('midBox', mbx, tt, { item: lin.units.get(four[0]).item, qty: four.length * PKG.cellsPerSmall });
    lin.pack(mbx, four, tt);
    ev(mbx, tt, 'Mid box (stuffing)', { tx: 'Pack HU (mid box)', sys: `${four.length} small boxes`, loc: 'TBL-STF', sloc: 'PACK', res: a.res.id, obj: ptObj(ptOf('TBL-STF')) });
    log(a, 'Pack: stuff mid box', start, tt);
    // palletize (waits for an empty pallet stand)
    const s2 = Math.max(tt, standFreeAt);
    if (!Number.isFinite(s2) || s2 >= DAY) { a.tFree = Math.max(a.tFree, tt); return backlog.push({ t: tt, what: 'palletize', unit: mbx }); }
    let t2 = s2;
    if (s2 > tt) { t2 = stay(a, tt, s2 - tt, 'Pack: wait for pallet stand', mbx, 'wait'); }
    t2 = move(a, t2, PK.palletize.at, 'Pack: palletize', mbx, 'carry');
    t2 = stay(a, t2, PK.palletize.sec, 'Pack: palletize', mbx);
    const stand = ptOf('TBL-PLT');
    ev(mbx, t2, 'Palletize', { tx: 'On pallet', loc: 'TBL-PLT', sloc: 'PACK', res: a.res.id, obj: ptObj(stand) });
    log(a, 'Pack: palletize', tt, t2);
    palletMids.push(mbx);
    if (palletMids.length === PKG.midPerLarge) {
      const mids = palletMids; palletMids = [];
      const lbx = ids.largeBox();
      lin.unit('largeBox', lbx, t2, { item: lin.units.get(mids[0]).item, qty: mids.length * PKG.smallPerMid * PKG.cellsPerSmall });
      lin.pack(lbx, mids, t2);
      ev(lbx, t2, 'Large box & banding', { tx: 'Pack HU (large box)', sys: `${mids.length} mid boxes`, loc: 'TBL-PLT', sloc: 'PACK', res: a.res.id, obj: ptObj(stand) });
      let t3 = move(a, t2, PK.band.at, 'Pack: band');
      t3 = stay(a, t3, PK.band.sec, 'Pack: band');
      const bnd = actors.get('BND-1');
      pushStay(bnd.track, t3 - PK.band.sec, PK.band.sec, bnd.pos, 'Pack: band', 'work', lbx);
      log(bnd, 'Pack: band', t3 - PK.band.sec, t3, 'machine');
      ev(lbx, t3, 'Large box & banding', { tx: 'Banded', sys: 'BND-1', loc: 'TBL-PLT', sloc: 'PACK', res: a.res.id, obj: ptObj(stand) });
      lin.units.get(lbx).attrs.bandedAt = t3;
      log(a, 'Pack: band', t2, t3);
      standFreeAt = Infinity; // until the forklift takes it (set inside fgPutaway)
      fgPutaway(t3, lbx);
    }
  }

  function fgPutaway(t, lbx) {
    const item = lin.units.get(lbx).item;
    const to = freeSlot('PA-FG', t, item);
    if (!to) throw new Error('FG high-bay full');
    const { a, start } = assign('fg-move', t);
    if (start >= DAY) { standFreeAt = Infinity; return backlog.push({ t, what: 'fgPutaway', unit: lbx }); }
    reserved.add(to.id);
    // pick time frees the stand
    const fromP = P.fgPickup;
    let tt = move(a, start, fromP, 'FG: putaway');
    tt = stay(a, tt, H.pickSec, 'FG: putaway', null, 'pick');
    standFreeAt = tt;
    ev(lbx, tt, 'FG putaway', { tx: 'TO pick', loc: 'TBL-PLT', sloc: 'PACK', res: a.res.id, obj: resObj(a) });
    tt = move(a, tt, to.ap, 'FG: putaway', lbx, 'carry');
    tt = stay(a, tt, H.putSec + (to.level - 1) * H.perLevelSec, 'FG: putaway', lbx, 'put');
    putSlot(to, lbx, tt);
    ev(lbx, tt, 'FG putaway', { tx: 'TO confirm', sys: 'High-bay bin', loc: to.id, sloc: 'FG01', res: a.res.id, obj: palObj(to) });
    log(a, 'FG: putaway', start, tt);
  }

  // ---- re-input: previous-day large boxes -> unpack -> magazines -> AS/RS -> next process ----
  const nRe = Math.round(L.volumes.daily.reinputLargeBoxes * f);
  for (let k = 0; k < nRe; k++) at(Math.round(2 * 3600 + k * (DAY - 6 * 3600) / Math.max(1, nRe)), (t) => reinputPick(t, k), 'reinput');

  function dummyLargeBox(s) {
    const o = occ.get(s.id);
    if (o.unit) return o.unit;
    const lbx = ids.largeBoxPrev();
    const lot = ids.lotFGPrev();
    lin.unit('largeBox', lbx, 0, { item: o.item, qty: PKG.midPerLarge * PKG.smallPerMid * PKG.cellsPerSmall, attrs: { dummy: true } });
    lin.alias(lot, lbx, 'lot');
    ev(lbx, 0, 'Opening stock', { tx: 'history omitted · dummy', sys: 'Stock overview', loc: s.id, sloc: 'FG01', obj: palObj(s), note: 'history omitted · dummy' });
    const mids = [];
    for (let i = 0; i < PKG.midPerLarge; i++) {
      const m = ids.midBoxPrev();
      lin.unit('midBox', m, 0, { item: o.item, qty: PKG.smallPerMid * PKG.cellsPerSmall, attrs: { dummy: true } });
      lin.alias(lot, m, 'lot');
      const smalls = [];
      for (let j = 0; j < PKG.smallPerMid; j++) {
        const sb = ids.smallBoxPrev();
        lin.unit('smallBox', sb, 0, { item: o.item, qty: PKG.cellsPerSmall, attrs: { dummy: true } });
        lin.alias(lot, sb, 'lot');
        smalls.push(sb);
      }
      lin.pack(m, smalls, 0);
      mids.push(m);
    }
    lin.pack(lbx, mids, 0);
    o.unit = lbx;
    return lbx;
  }

  function reinputPick(t, k) {
    const st = stockFor('PA-FG', t).filter((s) => !lin.units.get(occ.get(s.id).unit ?? '')?.attrs?.bandedAt);
    if (!st.length) { at(t + retry, (x) => reinputPick(x, k)); return; }
    const from = st[(k * 7) % st.length];
    const lbx = dummyLargeBox(from);
    const { a, start } = assign('fg-move', t);
    if (start >= DAY) return backlog.push({ t, what: 'reinputPick', unit: lbx });
    const end = palletMove(a, start, lbx, { slot: from }, { p: P.unpackDrop }, 'FG: re-input pick',
      { step: 'Re-input pick', tx: 'TO pick (re-input)', sloc: 'FG01' }, { step: 'Re-input pick', tx: 'Put (unpack area)', loc: 'PA-UNPK', sloc: 'UNPK' });
    at(end, (x) => unpackLBX(x, lbx), 'unpack');
  }

  let magCart = [];
  const mc = actors.get('MC-1');
  function unpackLBX(t, lbx) {
    const { a, start } = assign('unpack', t);
    if (start >= DAY) return backlog.push({ t, what: 'unpack', unit: lbx });
    const U = lin.units.get(lbx);
    let tt = move(a, start, PK.unpack.at, 'Unpack');
    tt = stay(a, tt, H.unpackMidSec, 'Unpack');
    lin.unpack(lbx, tt);
    ev(lbx, tt, 'Unpack', { tx: 'Unpack HU (large box)', sys: `${U.contents.length} mid boxes`, loc: 'TBL-UNPK', sloc: 'UNPK', res: a.res.id, obj: ptObj(P.unpackDrop) });
    const tbl = ptOf('TBL-UNPK');
    for (const mid of U.contents) {
      ev(mid, tt, 'Unpack', { tx: 'Out of large box', loc: 'TBL-UNPK', sloc: 'UNPK', res: a.res.id, obj: ptObj(P.unpackDrop) });
    }
    for (const mid of U.contents) {
      tt = stay(a, tt, H.unpackMidSec, 'Unpack', mid);
      lin.unpack(mid, tt);
      ev(mid, tt, 'Unpack', { tx: 'Unpack HU (mid box)', loc: 'TBL-UNPK', sloc: 'UNPK', res: a.res.id, obj: ptObj(tbl) });
      for (const sb of lin.units.get(mid).contents) {
        ev(sb, tt, 'Unpack', { tx: 'Out of mid box', loc: 'TBL-UNPK', sloc: 'UNPK', res: a.res.id, obj: ptObj(tbl) });
        tt = stay(a, tt, PK.unpack.sec, 'Unpack', sb);
        tt = move(a, tt, PK.magLoad.at, 'Magazine load', sb, 'carry');
        tt = stay(a, tt, PK.magLoad.sec, 'Magazine load', sb);
        const mz = ids.magazineRe();
        lin.unit('magazine', mz, tt, { item: lin.units.get(sb).item, qty: PKG.cellsPerMagazine, attrs: { reinput: true } });
        lin.derive(mz, [sb]);
        for (const l of Object.values(lin.units.get(sb).attrs.ids || {})) if (/^L/.test(l)) lin.alias(l, mz, 'lot');
        ev(sb, tt, 'Magazine load', { tx: 'Cells loaded to magazine', sys: `→ ${mz}`, loc: 'TBL-MAG', sloc: 'UNPK', res: a.res.id, obj: ptObj(ptOf('TBL-MAG')) });
        ev(mz, tt, 'Magazine load', { tx: 'Magazine on AMR cart', sys: `from ${sb}`, loc: 'MC-1', sloc: 'UNPK', res: a.res.id, obj: resObj(mc) });
        stageLog.push({ loc: 'MC-1', group: 'Magazine cart', unit: mz, tIn: tt, tOut: null });
        magCart.push(mz);
        if (magCart.length === PKG.magazinesPerAmrCart) {
          const batch = magCart; magCart = [];
          at(tt, (x) => amrIn(x, batch, P.magCart, 'reinput'), 'amrIn');
        }
        tt = move(a, tt, PK.unpack.at, 'Unpack');
      }
    }
    log(a, 'Unpack', start, tt);
  }

  function amrIn(t, batch, fromP, kind) {
    const { a, start } = assign('amrIn', t);
    if (start >= DAY) return backlog.push({ t, what: 'amrIn' });
    const task = kind === 'empty' ? 'AMR: empty magazines to AS/RS' : 'AMR: magazines to AS/RS';
    let tt = move(a, start, fromP, task);
    tt = stay(a, tt, H.amrLoadSec, task, null, 'pick');
    for (const u of batch) {
      ev(u, tt, 'AMR to AS/RS', { tx: kind === 'empty' ? 'Empty magazine pickup' : 'AMR pickup', loc: kind === 'empty' ? 'PACK' : 'MC-1', sloc: kind === 'empty' ? 'PACK' : 'UNPK', res: a.res.id, obj: resObj(a) });
      const r = stageLog.find((x) => x.unit === u && x.tOut === null);
      if (r) r.tOut = tt;
    }
    tt = move(a, tt, PK.asrsIn.at, task, batch.length, 'carry');
    tt = stay(a, tt, H.amrUnloadSec, task, batch.length, 'put');
    for (const u of batch) ev(u, tt, kind === 'empty' ? 'AMR to AS/RS' : 'AS/RS store', { tx: kind === 'empty' ? 'Empty magazine returned' : 'Put to AS/RS', loc: 'ASRS-1', sloc: 'ASRS', res: a.res.id, obj: ptObj(PK.asrsIn.at) });
    log(a, task, start, tt);
    if (kind === 'reinput') at(tt + H.asrsDwellMin * 60, (x) => amrOut(x, batch), 'amrOut');
  }

  function amrOut(t, batch) {
    const { a, start } = assign('amrOut', t);
    if (start >= DAY) return backlog.push({ t, what: 'amrOut' });
    const task = 'AMR: AS/RS to next process';
    let tt = move(a, start, PK.amrOut.at, task);
    tt = stay(a, tt, H.amrLoadSec, task, null, 'pick');
    for (const u of batch) ev(u, tt, 'AMR to next process', { tx: 'Retrieve to AMR', loc: 'ASRS-1', sloc: 'ASRS', res: a.res.id, obj: resObj(a) });
    tt = move(a, tt, PK.nextProcess.at, task, batch.length, 'carry');
    tt = stay(a, tt, PK.nextProcess.sec, task, batch.length, 'put');
    for (const u of batch) {
      ev(u, tt, 'Next process input', { tx: 'GI to next process', loc: 'PA-OUT', sloc: 'PROD', res: a.res.id, obj: ptObj(PK.nextProcess.at) });
      lin.units.get(u).attrs.consumedAt = tt;
    }
    log(a, task, start, tt);
  }

  // ================= run =================
  let guard = 0;
  while (Q.size) {
    const j = Q.pop();
    if (j.t >= DAY) { backlog.push({ t: j.t, what: j.tag || 'job' }); continue; }
    j.fn(j.t);
    if (++guard > 500000) throw new Error('schedule: job limit exceeded');
  }

  for (const a of actors.values()) a.track.segs.sort((x, y) => x.t0 - y.t0);
  lin.events.sort((x, y) => x.t - y.t);
  slotLog.sort((x, y) => x.t - y.t || x.d - y.d);
  taskLog.sort((x, y) => x.t0 - y.t0);

  const tracks = Object.fromEntries([...actors.entries()].map(([k, a]) => [k, a.track]));
  const resources = Object.fromEntries([...actors.entries()].map(([k, a]) => [k, a.res]));

  function positionOf(obj, t) {
    if (!obj) return null;
    if (obj.type === 'pal') { const s = slotById.get(obj.id); return [s.x, s.z]; }
    if (obj.type === 'pt') return obj.p;
    if (obj.type === 'res') return evalTrack(tracks[obj.id], t).p;
    return null;
  }

  // Trace examples (S4): deterministic picks from today's units
  const U = [...lin.units.values()];
  const examples = {
    rawMaterial: U.find((u) => u.kind === 'rmPallet' && !u.attrs.dummy && u.attrs.consumedAt !== undefined)?.attrs.ids?.barcode ?? null,
    largeBox: U.find((u) => u.kind === 'largeBox' && !u.attrs.dummy && u.attrs.bandedAt !== undefined)?.id ?? null,
    midBox: U.find((u) => u.kind === 'midBox' && u.attrs.dummy && u.attrs.unpackedAt !== undefined)?.id ?? null,
  };

  return {
    examples,
    assumptions: A, factor: f, slots, slotById, initialOcc, tracks, resources, lineage: lin, events: lin.events,
    slotLog, stageLog, taskLog, backlog, shortages, positionOf,
    counts: { rmPallets: nRM, deliveries: nDeliv, magazines: nMag, reinput: nRe, waves: perWave },
  };
}
