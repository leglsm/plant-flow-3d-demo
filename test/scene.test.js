// T6: pure scene helpers (no 3D library). WIP on tables, slot occupancy, stacking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runDay } from '../src/schedule.js';
import { occupiedAt } from '../src/metrics.js';
import { wipIntervals, wipAt, stackOffsets, SlotOcc, hms } from '../src/scenedata.js';

const L = JSON.parse(fs.readFileSync(new URL('../data/layout.json', import.meta.url)));
const R = runDay(L);
const asrsIn = L.packStations.points.find((p) => p.id === 'asrsIn').at;
const W = wipIntervals(R, { hide: [asrsIn] });

test('WIP intervals are finite, non-empty and sorted', () => {
  assert.ok(W.length > 1000);
  for (const w of W) {
    assert.ok(Number.isFinite(w.t1), `open-ended WIP ${w.unit} at ${w.key}`);
    assert.ok(w.t1 > w.t0);
  }
  for (let i = 1; i < W.length; i++) assert.ok(W[i].t0 >= W[i - 1].t0);
});

test('a unit is never drawn on a table while it is inside a container', () => {
  for (const w of W) {
    const u = R.lineage.units.get(w.unit);
    for (const iv of u.into) {
      const a = iv.t0, b = iv.t1 ?? Infinity;
      assert.ok(w.t1 <= a || w.t0 >= b, `${w.unit} drawn inside ${iv.id}`);
    }
  }
});

test('WIP position = trace target position (R11) at sampled times', () => {
  let checked = 0;
  for (let i = 0; i < W.length; i += 37) {
    const w = W[i];
    const t = (w.t0 + w.t1) / 2;
    const u = R.lineage.units.get(w.unit);
    let last = null;
    for (const e of u.ev) { if (e.t <= t) last = e; else break; }
    assert.equal(last.obj.type, 'pt');
    assert.deepEqual(last.obj.p, w.p);
    checked++;
  }
  assert.ok(checked > 50);
});

test('nothing piles up at the AS/RS input port (stored units are inside the AS/RS)', () => {
  const key = `${asrsIn[0].toFixed(2)},${asrsIn[1].toFixed(2)}`;
  assert.equal(W.filter((w) => w.key === key).length, 0);
});

test('WIP stacks stay small (largest group on one point)', () => {
  let max = 0;
  for (let t = 0; t < 86400; t += 300) for (const g of wipAt(W, t).values()) max = Math.max(max, g.length);
  assert.ok(max > 0 && max <= 40, `max stack ${max}`);
});

test('stack offsets: grid then layers, no two boxes in the same place', () => {
  const o = stackOffsets('smallBox', 9);
  assert.equal(o.length, 9);
  assert.equal(new Set(o.map((v) => v.join(','))).size, 9);
  assert.equal(o[0][1], 0);
  assert.ok(o[4][1] > 0); // 5th box starts the 2nd layer
  assert.equal(stackOffsets('largeBox', 2)[1][0], 0); // pallets stack straight up
});

test('SlotOcc forward/backward scrub = occupiedAt', () => {
  const s = new SlotOcc(R);
  for (const t of [0, 3600, 20000, 50000, 86399, 40000, 100, 60000, 59999]) {
    const a = [...s.at(t)].sort(), b = [...occupiedAt(R, t)].sort();
    assert.deepEqual(a, b, `t=${t}`);
  }
});

test('hms formats seconds of day', () => {
  assert.equal(hms(0), '00:00:00');
  assert.equal(hms(37800.7), '10:30:00');
  assert.equal(hms(86399), '23:59:59');
});

// ---- T9: heat map values (F-11) ----
import { heatValues, HEAT_RAMP } from '../src/scenedata.js';
import { computeMetrics } from '../src/metrics.js';
import { volumeLevel, volumeScenarios, overridesOf } from '../src/presets.js';

test('heat: 7-step ramp, every value falls inside its legend bin', () => {
  assert.equal(HEAT_RAMP.length, 7);
  const M = computeMetrics(R);
  for (const t of [3600, 40000, 80000]) {
    const h = heatValues(R.slots, 'occupancy', { occ: occupiedAt(R, t), freq: M.freq });
    h.bins.forEach((b, i) => { assert.ok(b >= 0 && b <= 6); const v = h.values[i]; const lg = h.legend[b]; assert.ok(v >= lg.from - 1e-9 && (v < lg.to || b === 6)); });
  }
  const f = heatValues(R.slots, 'frequency', { occ: new Set(), freq: M.freq });
  f.bins.forEach((b, i) => { const v = f.values[i], lg = f.legend[b]; assert.ok(v >= lg.from && v <= lg.to, `slot ${i} v=${v} bin=${b}`); });
  assert.ok(f.bins.some((b) => b === 6));
  assert.throws(() => heatValues(R.slots, 'rainbow', { occ: new Set(), freq: M.freq }));
});

test('heat occupancy: rack value = share of occupied positions in the bay', () => {
  const occ = occupiedAt(R, 40000);
  const h = heatValues(R.slots, 'occupancy', { occ, freq: new Map() });
  const i = R.slots.findIndex((s) => s.kind === 'rack');
  const s0 = R.slots[i];
  const bay = R.slots.filter((s) => s.row === s0.row && s.bay === s0.bay);
  assert.equal(h.values[i], bay.filter((s) => occ.has(s.id)).length / bay.length);
});

test('volume level run = the matching volumeScenarios entry; input day untouched', () => {
  const base = overridesOf(L, R.assumptions);
  const one = volumeLevel(L, base, 2);
  const all = volumeScenarios(L, base);
  assert.deepEqual(one.core, all[2].core);
  assert.deepEqual(all[0].core, computeMetrics(R).core);
  assert.equal(R.assumptions.volumeLevel, 0);
});
