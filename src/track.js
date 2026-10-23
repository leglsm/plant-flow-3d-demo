// Time-segment tracks (R2, R3). Screen state = evalTrack(track, t), a pure function.
// segment: {type:'move'|'stay', t0, t1, pts|p, task, phase, carry?, len?}
import { dist } from './geom.js';

export function makeTrack(id, home) {
  return { id, home: [...home], segs: [] };
}

export function pushMove(track, t0, pts, speed, task, phase, carry) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const len = cum[cum.length - 1];
  if (len < 1e-6) return t0;
  const t1 = t0 + len / speed;
  track.segs.push({ type: 'move', t0, t1, pts, cum, len, task, phase, carry: carry ?? null });
  return t1;
}

/** Move with a fixed duration (shuttle transit: visual distance is shortened). */
export function pushMoveTimed(track, t0, pts, dur, task, phase, carry) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  track.segs.push({ type: 'move', t0, t1: t0 + dur, pts, cum, len: cum[cum.length - 1], task, phase, carry: carry ?? null });
  return t0 + dur;
}

export function pushStay(track, t0, dur, p, task, phase, carry) {
  if (dur <= 0) return t0;
  track.segs.push({ type: 'stay', t0, t1: t0 + dur, p: [...p], task, phase, carry: carry ?? null });
  return t0 + dur;
}

function endPos(seg) {
  return seg.type === 'move' ? seg.pts[seg.pts.length - 1] : seg.p;
}

function lerpMove(seg, t) {
  const f = seg.t1 > seg.t0 ? Math.min(1, Math.max(0, (t - seg.t0) / (seg.t1 - seg.t0))) : 1;
  const d = f * seg.len;
  let i = 1;
  while (i < seg.cum.length - 1 && seg.cum[i] < d) i++;
  const a = seg.pts[i - 1], b = seg.pts[i];
  const sl = seg.cum[i] - seg.cum[i - 1];
  const g = sl > 0 ? (d - seg.cum[i - 1]) / sl : 1;
  return { p: [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g], heading: Math.atan2(b[0] - a[0], b[1] - a[1]) };
}

/** Index of the last segment with t0 <= t (binary search), -1 if none. */
function segIndex(track, t) {
  let lo = 0, hi = track.segs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track.segs[mid].t0 <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function evalTrack(track, t) {
  const i = segIndex(track, t);
  if (i < 0) return { p: track.home, heading: 0, task: 'idle', phase: null, moving: false, carry: null, seg: null };
  const s = track.segs[i];
  let heading = 0;
  for (let k = i; k >= 0; k--) if (track.segs[k].type === 'move') { const m = track.segs[k]; const n = m.pts.length; heading = Math.atan2(m.pts[n - 1][0] - m.pts[n - 2][0], m.pts[n - 1][1] - m.pts[n - 2][1]); break; }
  if (t >= s.t1) return { p: endPos(s), heading, task: 'idle', phase: null, moving: false, carry: null, seg: null };
  if (s.type === 'stay') return { p: s.p, heading, task: s.task, phase: s.phase, moving: false, carry: s.carry, seg: s };
  const m = lerpMove(s, t);
  return { p: m.p, heading: m.heading, task: s.task, phase: s.phase, moving: true, carry: s.carry, seg: s };
}
