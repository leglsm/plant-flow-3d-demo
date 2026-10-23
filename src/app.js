/*
 * Plant Flow 3D — fictional demo (Ridgeway Cell Works, Plant A). All data is invented.
 *
 * FEATURES (PRD F-01…F-16) — status in this build
 *   F-01 instant replay ............ yes (T6)
 *   F-02 time control .............. yes (T7): play/pause (Space), 1–300×, scrub re-places everything
 *   F-03/F-04 flows A/B ............ simulated (T2), drawn (T6), toggles (T7)
 *   F-05 navigation ................ yes (T7): flows, layers, go to zone, cameras, labels, m/ft
 *   F-06 selection detail .......... yes (T7)
 *   F-07 WIP on tables ............. yes (T6)
 *   F-08/F-09 lineage / trace ...... yes (T3, T8) — replay rides the shared clock
 *   F-10/F-11 analysis / heat map .. computed (T4); tab T9
 *   F-12/F-13 scenarios / compare .. computed (T4); tab T10
 *   F-14 settings view ............. T10
 *   F-15 flow tour ................. T11
 *   F-16 demo guide ................ T11
 *
 * SCHEMA: data/layout.json (see TRD 1.1). The viewer only reads it.
 */
import { runDay, DAY } from './schedule.js';
import { computeMetrics } from './metrics.js';
import { createScene } from './scene3d.js';
import { hms } from './scenedata.js';
import { buildOpsPane, buildSelection, makeUnits, phaseText } from './ui.js';
import { buildTracePane } from './trace.js';

const $ = (s) => document.querySelector(s);

function showError(err) {
  const box = $('#err');
  box.hidden = false;
  box.textContent = (box.textContent ? box.textContent + '\n\n' : '') + (err && err.stack ? err.stack : String(err));
  const ld = $('#loading'); if (ld) ld.hidden = true;
}
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

/** The one clock of the app (R2). Every view — 3D, selection, trace — reads clock.t. */
function makeClock(onSet) {
  const c = { t: 0, playing: true, speed: 60 };
  return {
    get t() { return c.t; }, get playing() { return c.playing; }, get speed() { return c.speed; },
    set(t) { c.t = Math.max(0, Math.min(DAY - 1, t)); onSet(c); },
    play(on) { c.playing = on; onSet(c); },
    setSpeed(v) { c.speed = v; onSet(c); },
    advance(dt) { if (!c.playing) return; c.t = Math.min(DAY - 1, c.t + dt * c.speed); if (c.t >= DAY - 1) c.playing = false; onSet(c, true); },
  };
}

async function main() {
  const res = await fetch('data/layout.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/layout.json: HTTP ${res.status}`);
  const L = await res.json();
  const t0 = performance.now();
  const R = runDay(L);
  const M = computeMetrics(R);
  const simMs = performance.now() - t0;

  const ui = { play: $('#play'), speed: $('#speed'), time: $('#time'), clock: $('#clock'), phase: $('#phase'), side: $('#side'), sideOpen: $('#side-open') };
  const units = makeUnits();
  let lastSec = -1, lastPhase = '', selTimer = 0;

  const clock = makeClock((c, fromFrame) => {
    view.setTime(c.t);
    ui.play.textContent = c.playing ? '❚❚' : '▶';
    ui.play.setAttribute('aria-pressed', String(c.playing));
    if (String(c.speed) !== ui.speed.value) ui.speed.value = String(c.speed);
    const sec = Math.floor(c.t);
    if (sec !== lastSec) { lastSec = sec; ui.clock.textContent = hms(sec); if (document.activeElement !== ui.time) ui.time.value = String(sec); }
    if (!fromFrame) { sel.render(); trace.tick(true); }
  });

  const view = createScene($('#view'), L, {
    labelLayer: $('#labels'),
    beforeFrame(dt) {
      clock.advance(dt);
      const ph = phaseText(clock.t, view.activity());
      if (ph !== lastPhase) { lastPhase = ph; ui.phase.textContent = ph; }
      trace.tick();
      selTimer += dt;
      if (selTimer > 0.25) { selTimer = 0; sel.render(); }
    },
    onReady() { $('#loading').hidden = true; window.__pf.readyAt = performance.now(); },
  });

  const ctx = {
    L, R, M, view, clock, units,
    select: (s) => sel.set(s),
    openTrace: (id) => { setTab('trace'); trace.open(id); },
    isTabVisible: (tab) => curTab === tab && !ui.side.classList.contains('closed'),
  };
  const ops = buildOpsPane($('#pane-ops'), ctx);
  const sel = buildSelection($('#sel'), ctx);
  const trace = buildTracePane($('#pane-trace'), ctx);

  view.setResult(R);
  ops.setResult(R);
  trace.setResult(R);
  view.onPick = (info) => sel.set(info && info.kind !== 'point' ? info : info);
  clock.set(0);

  // ---- tabs & side panel ----
  let curTab = 'ops';
  const titles = { ops: '3D Operations', trace: 'Lot Trace', analysis: 'Analysis', settings: 'Settings' };
  function setTab(tab) {
    curTab = tab;
    for (const b of document.querySelectorAll('[data-tab]')) { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    for (const p of document.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === tab);
    $('#side-title').textContent = titles[tab];
    setSide(true);
  }
  function setSide(open) { ui.side.classList.toggle('closed', !open); ui.sideOpen.hidden = open; }
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#side-close').addEventListener('click', () => setSide(false));
  ui.sideOpen.addEventListener('click', () => setSide(true));
  if (window.matchMedia('(max-width: 760px)').matches) setSide(false); // phones: 3D first

  // ---- bottom bar ----
  ui.play.addEventListener('click', () => clock.play(!clock.playing));
  ui.speed.addEventListener('change', () => clock.setSpeed(Number(ui.speed.value)));
  ui.time.addEventListener('input', () => clock.set(Number(ui.time.value)));
  for (const b of document.querySelectorAll('[data-cam]')) {
    b.addEventListener('click', () => {
      view.setCamera(b.dataset.cam);
      for (const o of document.querySelectorAll('[data-cam]')) o.classList.toggle('on', o === b);
    });
  }
  $('#labelsel').addEventListener('change', (e) => view.setLabels(e.target.value));
  $('#units').addEventListener('click', (e) => { e.target.textContent = units.toggle() ? 'ft' : 'm'; sel.render(); });
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) && document.activeElement.type !== 'range') return;
    if (e.code === 'Space' && tag !== 'BUTTON') { e.preventDefault(); clock.play(!clock.playing); }
    else if (e.key === 'm' || e.key === 'M') setSide(ui.side.classList.contains('closed'));
    else if (e.key === 'Escape') sel.set(null);
  });

  // test / debugging hooks (read-only use by e2e)
  window.__pf = {
    L, R, M, view, simMs, clock, trace, sel, setTab,
    get t() { return clock.t; },
    setTime(t) { clock.set(t); },
    setPlaying(on) { clock.play(on); },
    get playing() { return clock.playing; },
  };
}

main().catch(showError);
