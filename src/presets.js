// Presets and scenarios (R14, R15). Always a full recompute; the caller's assumptions are
// never mutated, so "restore the original settings" is automatic.
import { runDay, mergeAssumptions } from './schedule.js';
import { computeMetrics } from './metrics.js';

export function presetOverrides(L, presetId) {
  const p = L.presets.find((x) => x.id === presetId);
  if (!p) throw new Error(`unknown preset ${presetId}`);
  for (const k of Object.keys(p.set)) if (!(k in L.assumptions)) throw new Error(`preset ${presetId}: ${k} is not an assumption`);
  return structuredClone(p.set);
}

/** Assumptions for a preset on top of the base (base keys a preset does not set stay as they are). */
export function presetAssumptions(L, presetId, base = {}) {
  return mergeAssumptions(mergeAssumptions(L.assumptions, base), presetOverrides(L, presetId));
}

const toOver = (L, A) => Object.fromEntries(Object.keys(L.assumptions).filter((k) => k !== 'src' && k !== 'doc').map((k) => [k, A[k]]));

/** S7 / F-13: same day, three presets. */
export function comparePresets(L, base = {}) {
  return L.presets.map((p) => {
    const A = presetAssumptions(L, p.id, base);
    const R = runDay(L, toOver(L, A));
    const M = computeMetrics(R);
    return { id: p.id, label: p.label, desc: p.desc, assumptions: A, core: M.core, metrics: M };
  });
}

/** S6 / F-12: volume levels 0–4 under the given assumptions. */
export function volumeScenarios(L, base = {}) {
  return L.volumes.levels.map((lv) => {
    const R = runDay(L, { ...base, volumeLevel: lv.level });
    const M = computeMetrics(R);
    return { level: lv.level, factor: lv.factor, core: M.core, packingBottleneck: M.packingBottleneck, stations: M.stations, bottlenecks: M.bottlenecks, backlog: M.backlog };
  });
}
