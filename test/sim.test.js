// T5 — schedule / lineage / metrics / presets (R1–R16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32 } from '../src/rng.js';
import { runDay, DAY, STEPS } from '../src/schedule.js';
import { makeRouter, segHitsRect, dist } from '../src/geom.js';
import { evalTrack } from '../src/track.js';
import { idPatterns } from '../src/ids.js';
import { computeMetrics, occupancyAt } from '../src/metrics.js';
import { comparePresets, volumeScenarios } from '../src/presets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const L = JSON.parse(readFileSync(join(ROOT, 'data/layout.json'), 'utf8'));
const t0 = performance.now();
const R = runDay(L);
const runMs = performance.now() - t0;
const units = [...R.lineage.units.values()];

const digest = (r) => createHash('sha256').update(JSON.stringify({
  ev: r.events.map((e) => [e.t, e.unit, e.step, e.tx, e.res, e.obj]),
  tr: Object.entries(r.tracks).map(([k, t]) => [k, t.segs.map((s) => [s.t0, s.t1, s.task, s.pts ?? s.p])]),
})).digest('hex');

test('mulberry32: JS and Python generators produce the same sequence (D-17)', () => {
  const r = spawnSync('python3', ['-c', `import importlib.util,sys
spec=importlib.util.spec_from_file_location('b','${join(ROOT, 'tools/build_layout.py')}');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
r=b.mulberry32(${L.meta.seed});print(','.join(repr(r()) for _ in range(8)))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const js = mulberry32(L.meta.seed);
  assert.deepEqual(r.stdout.trim().split(',').map(Number), Array.from({ length: 8 }, () => js()));
});

test('R1 deterministic: same layout + assumptions -> identical day', () => {
  assert.equal(digest(runDay(L)), digest(R));
});

test('runs fast enough for in-browser recompute', () => {
  assert.ok(runMs < 2000, `runDay took ${runMs.toFixed(0)} ms`);
});

test('day scale (level 0): units 3,000–4,000, all flows complete', () => {
  assert.ok(units.length >= 3000 && units.length <= 4000, `units ${units.length}`);
  const ev = (step, tx) => R.events.filter((e) => e.step === step && (!tx || e.tx.startsWith(tx))).length;
  assert.equal(ev('GR at offsite'), R.counts.rmPallets);
  assert.equal(ev('In transit', 'STO'), R.counts.rmPallets);
  assert.equal(units.filter((u) => u.kind === 'largeBox' && u.attrs.bandedAt <= DAY).length, L.volumes.daily.fgLargeBoxes);
  assert.ok(units.filter((u) => u.kind === 'rmPallet' && u.attrs.consumedAt <= DAY).length >= R.counts.rmPallets - 2);
  assert.equal(R.stageLog.filter((s) => s.tOut === null).length, 0, 'every staged pallet/magazine leaves staging');
});

test('R3/R9 tracks: sorted, non-overlapping, every segment has a task', () => {
  for (const [id, tr] of Object.entries(R.tracks)) {
    for (let i = 0; i < tr.segs.length; i++) {
      const s = tr.segs[i];
      assert.ok(s.task, `${id} segment without task`);
      assert.ok(s.t1 >= s.t0, `${id} negative segment`);
      if (i) assert.ok(s.t0 >= tr.segs[i - 1].t1 - 1e-6, `${id} overlap at ${s.t0}`);
    }
  }
});

test('R8 no movement passes through racks or equipment', () => {
  const sol = makeRouter(L).solids;
  const hits = [];
  for (const [id, tr] of Object.entries(R.tracks)) for (const s of tr.segs) {
    if (s.type !== 'move') continue;
    for (let i = 1; i < s.pts.length; i++) for (const so of sol) if (segHitsRect(s.pts[i - 1], s.pts[i], so.rect)) hits.push(`${id} ${s.task} x ${so.id}`);
  }
  assert.deepEqual(hits, []);
});

test('router reaches every pair of pack/hand-off points', () => {
  const r = makeRouter(L);
  const pts = [...L.packStations.points.map((p) => p.at), ...Object.values(L.points).filter(Array.isArray)].filter((p) => p[0] >= 100);
  for (const p of pts) for (const q of pts) assert.doesNotThrow(() => r.route(p, q));
});

test('slot occupancy stays 0/1 (initial stock + slot log)', () => {
  const st = new Map([...R.initialOcc.keys()].map((k) => [k, 1]));
  for (const e of R.slotLog) {
    const v = (st.get(e.slot) || 0) + e.d;
    assert.ok(v === 0 || v === 1, `${e.slot} -> ${v} at ${e.t}`);
    st.set(e.slot, v);
  }
  const o = occupancyAt(R, 'PA-RM', 12 * 3600);
  assert.ok(o > 0 && o <= 1);
});

test('R5/R11 trace position = 3D position at every pick and put', () => {
  let n = 0;
  for (const u of units) {
    for (let i = 1; i < u.ev.length; i++) {
      const a = u.ev[i - 1], b = u.ev[i];
      if (a.obj.type === 'pal' && b.obj.type === 'res') { // picked from a slot
        const p = evalTrack(R.tracks[b.obj.id], b.t).p;
        assert.ok(dist(p, R.slotById.get(a.obj.id).ap) < 1e-6, `${u.id} pick ${a.obj.id}`); n++;
      }
      if (a.obj.type === 'res' && b.obj.type === 'pal') { // put into a slot
        const p = evalTrack(R.tracks[a.obj.id], b.t).p;
        assert.ok(dist(p, R.slotById.get(b.obj.id).ap) < 1e-6, `${u.id} put ${b.obj.id}`); n++;
      }
    }
  }
  assert.ok(n > 1000, `checked ${n}`);
});

test('R6 ids: unique, formats match idFormats, groups only for document ids', () => {
  const pat = idPatterns(L.idFormats);
  const kindPat = { rmPallet: pat.barcode, magazine: pat.magazine, smallBox: pat.smallBox, midBox: pat.midBox, largeBox: pat.largeBox };
  for (const u of units) assert.match(u.id, kindPat[u.kind], u.id);
  for (const [alias, list] of R.lineage.aliases) {
    if (list.length > 1) assert.match(alias, new RegExp(`${pat.po.source}|${pat.grDoc.source}|${pat.batch.source}|${pat.lot.source}|${pat.transfer.source}`), alias);
  }
  for (const u of units) for (const [k, v] of Object.entries(u.attrs.ids || {})) {
    const p = { po: pat.po, grDoc: pat.grDoc, batch: pat.batch, barcode: pat.barcode, lot: pat.lot, sto: pat.transfer, transfer: pat.transfer }[k];
    assert.match(v, p, `${u.id} ${k} ${v}`);
  }
});

test('R10 trace examples: raw material, large box, mid box from re-input', () => {
  const { rawMaterial, largeBox, midBox } = R.examples;
  const steps = (id) => new Set(R.lineage.trace(id).timeline.map((e) => e.step));
  const rm = steps(rawMaterial);
  for (const s of STEPS.A) assert.ok(rm.has(s), `RM trace missing ${s}`);
  const lb = steps(largeBox);
  for (const s of ['AS/RS discharge', 'ID & label', 'Inspection', 'Shrink wrap', 'Flat cart', 'Mid box (stuffing)', 'Palletize', 'Large box & banding', 'FG putaway']) assert.ok(lb.has(s), `LBX trace missing ${s}`);
  const md = steps(midBox);
  for (const s of ['Opening stock', 'Re-input pick', 'Unpack', 'Magazine load', 'AMR to AS/RS', 'AS/RS store', 'AMR to next process', 'Next process input']) assert.ok(md.has(s), `MBX trace missing ${s}`);
  // any id of the same pallet resolves to the same unit
  const u = R.lineage.units.get(R.lineage.resolve(rawMaterial)[0]);
  for (const id of Object.values(u.attrs.ids)) assert.ok(R.lineage.resolve(id).includes(u.id), id);
  assert.equal(R.lineage.trace('NOPE-123'), null);
  // timeline sorted
  const tl = R.lineage.trace(largeBox).timeline;
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i].t >= tl[i - 1].t);
});

test('R12 previous-day large box has dummy history (24 mid, 96 small)', () => {
  const m = R.lineage.units.get(R.examples.midBox);
  const lbx = R.lineage.units.get(m.into[0].id);
  assert.equal(lbx.attrs.dummy, true);
  assert.equal(lbx.contents.length, 24);
  assert.equal(lbx.contents.reduce((s, id) => s + R.lineage.units.get(id).contents.length, 0), 96);
  assert.equal(lbx.ev.filter((e) => /dummy/.test(e.note || '')).length, 1);
});

test('R13 metrics: shapes and ranges', () => {
  const M = computeMetrics(R);
  assert.ok(M.core.packingUtilization > 0 && M.core.packingUtilization <= 1);
  assert.equal(M.core.dailyThroughput, 12);
  assert.ok(M.core.stagingDwellAvg > 0);
  assert.equal(M.hourly.length, 24);
  for (const r of Object.values(M.perRes)) assert.ok(r.util >= 0 && r.util <= 1.0001, `${r.id} ${r.util}`);
  assert.ok(M.concurrentMax >= 1);
});

test('R14/R15 three presets: full recompute, base untouched, differences visible', () => {
  const before = JSON.stringify(L.assumptions);
  const cmp = comparePresets(L);
  assert.equal(JSON.stringify(L.assumptions), before);
  const [w, i, b] = cmp;
  assert.deepEqual(cmp.map((c) => c.label), ['AS-WAS', 'AS-IS', 'TO-BE']);
  assert.ok(b.core.packingUtilization < i.core.packingUtilization, 'TO-BE lowers packing utilization');
  const line = (c) => c.metrics.dwellByGroup['Line staging'].avg;
  assert.ok(line(w) > line(i) && line(i) > line(b), 'line staging dwell AS-WAS > AS-IS > TO-BE');
  assert.ok(w.core.stagingDwellAvg > b.core.stagingDwellAvg);
});

test('S6 volume levels: packing load rises and becomes the bottleneck', () => {
  const v = volumeScenarios(L);
  for (let k = 1; k < v.length; k++) assert.ok(v[k].core.packingUtilization >= v[k - 1].core.packingUtilization - 1e-9);
  assert.ok(v[0].core.packingUtilization <= 0.85, 'level 0 not a bottleneck');
  const first = v.find((x) => x.core.packingUtilization >= 0.85);
  assert.ok(first && first.level >= 1 && first.level <= 3, `first bottleneck level ${first?.level}`);
  const two = volumeScenarios(L, { packOption: 2 });
  assert.ok(two[4].core.dailyThroughput > v[4].core.dailyThroughput, 'second wrapper raises capacity at level 4');
});
