// T1 — fictional plant layout: determinism, schema, source tags, generator checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const L = JSON.parse(readFileSync(join(ROOT, 'data/layout.json'), 'utf8'));
const py = (...args) => spawnSync('python3', [join(ROOT, 'tools/build_layout.py'), ...args], { encoding: 'utf8' });

test('generator is deterministic and data/layout.json is up to date', () => {
  const r = py('--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('generator checks catch broken layouts (negative cases)', () => {
  const r = py('--selftest');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('top-level schema (TRD 1.1)', () => {
  for (const k of ['meta', 'defaults', 'modules', 'zones', 'rackRows', 'floors', 'equipment', 'docks', 'corridors',
    'items', 'volumes', 'resourceTypes', 'resources', 'staffing', 'staffingTotal', 'packStations',
    'assumptions', 'presets', 'idFormats']) assert.ok(k in L, `missing ${k}`);
  assert.equal(L.meta.units, 'm');
  assert.equal(L.meta.fictional, true);
  assert.deepEqual(Object.keys(L.defaults.rackTypes).sort(), ['highbay', 'selective']);
  const p = L.defaults.packing;
  assert.deepEqual([p.cellsPerSmall, p.smallPerMid, p.midPerLarge], [300, 4, 24]);
});

test('every numeric value has a source tag on itself or an ancestor', () => {
  const ok = new Set(['fictional', 'estimate', 'assumption']);
  const missing = [];
  const walk = (node, path, inherited) => {
    if (Array.isArray(node)) {
      if (node.some((v) => typeof v === 'number') && !inherited) missing.push(path);
      node.forEach((v, i) => typeof v === 'object' && v && walk(v, `${path}[${i}]`, inherited));
      return;
    }
    if (node.src !== undefined) assert.ok(ok.has(node.src), `${path}.src = ${node.src}`);
    const tag = node.src ?? inherited;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'number' && !tag) missing.push(`${path}.${k}`);
      else if (v && typeof v === 'object') walk(v, `${path}.${k}`, tag);
    }
  };
  // meta.seed/version, idFormats digits and compareMetrics are format/config, not plant numbers.
  const { meta, idFormats, compareMetrics, ...rest } = L;
  walk(rest, '$', null);
  assert.deepEqual(missing, []);
});

test('ids unique, references resolve', () => {
  const zoneIds = new Set(L.zones.map((z) => z.id));
  const all = [];
  for (const k of ['modules', 'zones', 'rackRows', 'floors', 'equipment', 'docks', 'corridors', 'resources', 'presets'])
    all.push(...L[k].map((o) => o.id));
  assert.equal(new Set(all).size, all.length);
  const pns = new Set(L.items.map((i) => i.pn));
  for (const r of L.rackRows) {
    assert.ok(zoneIds.has(r.zone));
    r.items.forEach((pn) => assert.ok(pns.has(pn), `${r.id} item ${pn}`));
    assert.ok(r.fill >= 0 && r.fill <= 1);
  }
  const types = new Set(L.resourceTypes.map((t) => t.id));
  for (const r of L.resources) { assert.ok(types.has(r.type), r.id); assert.ok(zoneIds.has(r.zone), r.id); }
  for (const i of L.items) assert.match(i.pn, i.kind === 'RM' ? /^RM-1\d{5}$/ : /^FG-\d{6}$/);
});

test('CAPA within ±10% and staffing totals', () => {
  for (const z of L.zones.filter((z) => z.capa)) {
    assert.ok(Math.abs(z.capaCalc - z.capa) <= 0.1 * z.capa, `${z.id} ${z.capaCalc}/${z.capa}`);
  }
  const persons = L.resources.filter((r) => r.person !== false).length;
  const table = L.staffing.reduce((s, x) => s + x.n, 0);
  assert.equal(persons, table);
  assert.equal(table, L.staffingTotal.persons);
});

test('presets only override assumption keys (R15)', () => {
  const keys = new Set(Object.keys(L.assumptions));
  for (const p of L.presets) for (const k of Object.keys(p.set)) assert.ok(keys.has(k), `${p.id}.${k}`);
  assert.deepEqual(L.presets.map((p) => p.label), ['AS-WAS', 'AS-IS', 'TO-BE']);
  assert.deepEqual(L.compareMetrics.core, ['packingUtilization', 'dailyThroughput', 'stagingDwellAvg']);
  assert.equal(L.volumes.levels.length, 5);
});
