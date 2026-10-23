/*
 * Plant Flow 3D — fictional demo (Ridgeway Cell Works, Plant A). All data is invented.
 *
 * FEATURES (PRD F-01…F-16) — status in this build
 *   F-01 instant replay ............ yes (T6)
 *   F-02 time control .............. basic bar (T6); full bar T7
 *   F-03/F-04 flows A/B ............ simulated (T2), drawn (T6)
 *   F-05 navigation ................ cameras orbit/walk/top (T6); drawer, layers T7
 *   F-06 selection detail .......... pick hook (T6); panel T7
 *   F-07 WIP on tables ............. yes (T6)
 *   F-08/F-09 lineage / trace ...... computed (T3); tab T8
 *   F-10/F-11 analysis / heat map .. computed (T4); tab T9
 *   F-12/F-13 scenarios / compare .. computed (T4); tab T10
 *   F-14 settings view ............. T10
 *   F-15 flow tour ................. T11
 *   F-16 demo guide ................ T11
 *
 * SCHEMA: data/layout.json (see TRD 1.1). The viewer only reads it.
 */
import { runDay, DAY } from './schedule.js';
import { createScene } from './scene3d.js';
import { hms } from './scenedata.js';

const $ = (s) => document.querySelector(s);

function showError(err) {
  const box = $('#err');
  box.hidden = false;
  box.textContent = (box.textContent ? box.textContent + '\n\n' : '') + (err && err.stack ? err.stack : String(err));
  const ld = $('#loading'); if (ld) ld.hidden = true;
}
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

async function main() {
  const res = await fetch('data/layout.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/layout.json: HTTP ${res.status}`);
  const L = await res.json();
  const t0 = performance.now();
  const R = runDay(L);
  const simMs = performance.now() - t0;

  const play = { on: true, speed: 60, t: 0 };
  const ui = {
    play: $('#play'), speed: $('#speed'), time: $('#time'), clock: $('#clock'), pick: $('#pick'),
  };
  let lastClock = -1;

  const view = createScene($('#view'), L, {
    labelLayer: $('#labels'),
    beforeFrame(dt) {
      if (play.on) {
        play.t = Math.min(DAY - 1, play.t + dt * play.speed);
        if (play.t >= DAY - 1) setPlaying(false);
      }
      view.setTime(play.t);
      const sec = Math.floor(play.t);
      if (sec !== lastClock) { lastClock = sec; ui.clock.textContent = hms(sec); ui.time.value = String(sec); }
    },
    onReady() { $('#loading').hidden = true; window.__pf.readyAt = performance.now(); },
  });
  view.setResult(R);
  view.onPick = (info) => {
    // T6: minimal readout; the Selection panel comes in T7
    if (!info) { ui.pick.hidden = true; return; }
    ui.pick.hidden = false;
    ui.pick.textContent = `${info.kind}${info.id ? ': ' + info.id : ''}\n(${info.p[0].toFixed(1)}, ${info.p[1].toFixed(1)}) m`;
  };

  function setPlaying(on) {
    play.on = on;
    ui.play.textContent = on ? '❚❚' : '▶';
    ui.play.setAttribute('aria-pressed', String(on));
  }
  ui.play.addEventListener('click', () => setPlaying(!play.on));
  ui.speed.addEventListener('change', () => { play.speed = Number(ui.speed.value); });
  ui.time.addEventListener('input', () => { play.t = Number(ui.time.value); view.setTime(play.t); });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) { e.preventDefault(); setPlaying(!play.on); }
  });
  for (const b of document.querySelectorAll('[data-cam]')) {
    b.addEventListener('click', () => {
      view.setCamera(b.dataset.cam);
      for (const o of document.querySelectorAll('[data-cam]')) o.classList.toggle('on', o === b);
    });
  }

  // test / debugging hooks (read-only use by e2e)
  window.__pf = {
    L, R, view, simMs,
    get t() { return play.t; },
    setTime(t) { play.t = t; view.setTime(t); },
    setPlaying,
    get playing() { return play.on; },
  };
}

main().catch(showError);
