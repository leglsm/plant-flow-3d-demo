// T8: trace helpers (pure parts of the Lot Trace tab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runDay } from '../src/schedule.js';
import { eventIndexAt, similarIds } from '../src/trace.js';

const L = JSON.parse(fs.readFileSync(new URL('../data/layout.json', import.meta.url)));
const R = runDay(L);

test('eventIndexAt = last event at or before t', () => {
  const tl = [{ t: 10 }, { t: 20 }, { t: 20 }, { t: 30 }];
  assert.equal(eventIndexAt(tl, 5), -1);
  assert.equal(eventIndexAt(tl, 10), 0);
  assert.equal(eventIndexAt(tl, 25), 2);
  assert.equal(eventIndexAt(tl, 99), 3);
});

test('eventIndexAt agrees with lineage.objAt (R11) on the examples', () => {
  for (const id of Object.values(R.examples)) {
    const tr = R.lineage.trace(id);
    for (let t = 0; t < 86400; t += 97) {
      const i = eventIndexAt(tr.timeline, t);
      assert.deepEqual(i < 0 ? null : tr.timeline[i].obj, R.lineage.objAt(tr, t));
    }
  }
});

test('similarIds: same kind by ID format, only IDs that exist', () => {
  const s = similarIds(R, L.idFormats, 'lbx-9999');
  assert.equal(s.kind, 'largeBox');
  assert.equal(s.ids.length, 3);
  for (const x of s.ids) assert.ok(R.lineage.resolve(x).length > 0);
  assert.equal(similarIds(R, L.idFormats, 'hello').kind, null);
});
