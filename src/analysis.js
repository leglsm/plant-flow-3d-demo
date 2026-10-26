// T9: Analysis tab (F-10, F-11, F-12; S5, S6). Reads the run result + metrics; the volume
// scenarios are full re-runs (R14) and never touch the day being shown.
import { BOTTLENECK, occupancyAt } from './metrics.js';
import { volumeLevel, overridesOf } from './presets.js';
import { HEAT_RAMP } from './scenedata.js';
import { esc, pct } from './ui.js';

const min = (s) => `${(s / 60).toFixed(1)} min`;

export function buildAnalysisPane(el, ctx) {
  const st = { heat: null, lastHour: -1, lastLive: 0, scen: null, running: false };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'heat') setHeat(b.dataset.mode === 'off' ? null : b.dataset.mode);
    if (a === 'hour') ctx.clock.set(Number(b.dataset.h) * 3600);
    if (a === 'res') { ctx.select({ kind: 'resource', id: b.dataset.id }); const p = ctx.view.objPos({ type: 'res', id: b.dataset.id }); if (p) ctx.view.focus(p, { radius: 14 }); }
    if (a === 'zone') { const z = ctx.L.zones.find((x) => x.id === b.dataset.id); ctx.select({ kind: 'zone', id: z.id }); ctx.view.focus([(z.rect[0] + z.rect[2]) / 2, (z.rect[1] + z.rect[3]) / 2], { radius: Math.max(z.rect[2] - z.rect[0], z.rect[3] - z.rect[1]) * 0.6 }); }
    if (a === 'scen') runScenarios();
  });

  function setHeat(mode) {
    st.heat = mode;
    const r = ctx.view.setHeat(mode, { freq: ctx.M.freq });
    el.querySelectorAll('[data-act=heat]').forEach((b) => { const on = (b.dataset.mode === 'off' ? null : b.dataset.mode) === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const lg = el.querySelector('#heat-legend');
    if (!mode) { lg.innerHTML = '<span class="small muted">Off — stored pallets are shown.</span>'; return; }
    const fmt = (x) => (mode === 'occupancy' ? `${Math.round(x.from * 100)}–${Math.round(x.to * 100)}%` : x.from === x.to ? `${x.from}` : `${x.from}–${x.to}`);
    lg.innerHTML = `<div class="legend">${r.legend.map((x, i) => `<span class="sw"><i style="background:${HEAT_RAMP[i]}"></i>${esc(fmt(x))}</span>`).join('')}</div>
      <div class="small muted">${mode === 'occupancy' ? 'Share of occupied positions per rack bay (all levels) at the current time; floor slots 0 / 100%. Follows the time slider.' : `Puts + picks per slot today (log scale, busiest slot ${r.max}). Pallets are hidden while the heat map is on.`}</div>`;
  }

  function render() {
    const { R, M, L } = ctx;
    const core = M.core;
    const line = M.dwellByGroup['Line staging'];
    const stations = M.stations.slice().sort((a, b) => b.util - a.util);
    const res = Object.values(M.perRes).sort((a, b) => b.util - a.util);
    const maxH = Math.max(1, ...M.hourly);
    el.innerHTML = `
      <h3>Heat map (3D)</h3>
      <div class="seg" role="group" aria-label="Heat map">
        <button class="btn sm on" data-act="heat" data-mode="off" aria-pressed="true">Off</button><button class="btn sm" data-act="heat" data-mode="occupancy" aria-pressed="false">Occupancy now</button><button class="btn sm" data-act="heat" data-mode="frequency" aria-pressed="false">Pick + put today</button>
      </div>
      <div id="heat-legend" class="heat-legend"></div>

      <h3>Key numbers · this day</h3>
      <div class="tiles">
        <div class="tile"><b>${pct(core.packingUtilization)}</b><span>Packing utilization<br><span class="muted">busiest station: ${esc(stations[0].label)}</span></span></div>
        <div class="tile"><b>${core.dailyThroughput}</b><span>Large boxes banded<br><span class="muted">daily throughput</span></span></div>
        <div class="tile"><b>${line ? min(line.avg) : '—'}</b><span>Line handover dwell<br><span class="muted">avg, ${line ? line.n : 0} pallets</span></span></div>
        <div class="tile"><b>${M.rmConsumed}</b><span>RM pallets to line<br><span class="muted">backlog at midnight: ${M.backlog}</span></span></div>
      </div>

      <h3>Packing stations · utilization</h3>
      ${bars(stations.map((s) => ({ label: s.label, v: s.util, sub: s.resources.join(', ') })))}

      <h3>Workload by hour · task starts</h3>
      <svg class="hours" viewBox="0 0 240 70" role="img" aria-label="Task starts per hour">
        ${M.hourly.map((v, h) => { const bh = Math.max(v ? 1.5 : 0, (v / maxH) * 52); return `<g class="hr" data-act="hour" data-h="${h}"><title>${String(h).padStart(2, '0')}:00 — ${v} task starts</title><rect class="hit" x="${h * 10}" y="0" width="10" height="62"></rect><rect class="bar" data-h="${h}" x="${h * 10 + 1.5}" y="${56 - bh}" width="7" height="${bh}" rx="1.5"></rect></g>`; }).join('')}
        <line x1="0" y1="56.5" x2="240" y2="56.5" class="base"></line>
        ${[0, 6, 12, 18].map((h) => `<text x="${h * 10 + 1}" y="68">${String(h).padStart(2, '0')}</text>`).join('')}
      </svg>
      <div class="small muted">Peak ${maxH} starts/h · up to ${M.concurrentMax} moving at once (30 s window). Click an hour to jump there.</div>

      <h3>Staging dwell (put → pick)</h3>
      <table class="tbl"><thead><tr><th>Area</th><th>Pairs</th><th>Avg</th><th>Max</th></tr></thead><tbody>
        ${Object.entries(M.dwellByGroup).map(([g, d]) => `<tr><td>${esc(g === 'Line staging' ? 'Line handover' : g)}</td><td>${d.n}</td><td>${min(d.avg)}</td><td>${min(d.max)}</td></tr>`).join('')}
        <tr class="tot"><td>All</td><td>${Object.values(M.dwellByGroup).reduce((s, d) => s + d.n, 0)}</td><td>${min(core.stagingDwellAvg)}</td><td></td></tr>
      </tbody></table>

      <h3>Zones · occupancy now · cube use</h3>
      <table class="tbl"><thead><tr><th>Zone</th><th>Now</th><th>Cube</th></tr></thead><tbody id="zone-occ">${zoneRows()}</tbody></table>

      <h3>People & equipment · utilization</h3>
      ${bars(res.map((r) => ({ label: r.name, v: r.util, id: r.id, sub: `${r.tasks} tasks · ${ctx.units.len(r.distance.total)}` })), true)}

      <h3>Volume scenarios (levels 0–4)</h3>
      <p class="small muted">Re-runs the whole day at ${L.volumes.levels.map((x) => `${Math.round(x.factor * 100)}%`).join(' / ')} volume with the current setup. The day on screen is not changed.</p>
      <button class="btn sm primary" data-act="scen" id="scen-run">Run 5 scenarios</button>
      <div id="scen-out" aria-live="polite"></div>

      <h3>Bottleneck candidates (&gt; ${Math.round(BOTTLENECK * 100)}%)</h3>
      ${M.bottlenecks.length ? `<ul class="plain">${M.bottlenecks.map((b) => `<li>▲ ${esc(b.label)} — ${pct(b.util)}</li>`).join('')}</ul>` : '<p class="small muted">None at this volume. Run the volume scenarios to see where packing saturates.</p>'}`;
    setHeat(st.heat);
    if (st.scen) renderScen();
    tick(true);
  }

  function bars(rows, clickable = false) {
    return `<div class="bars">${rows.map((r) => {
      const over = r.v > BOTTLENECK;
      const tag = clickable ? `button class="brow" data-act="res" data-id="${esc(r.id)}"` : 'div class="brow"';
      return `<${tag} title="${esc(r.sub || '')}"><span class="bl">${esc(r.label)}</span><span class="bt"><i style="width:${Math.min(100, r.v * 100).toFixed(1)}%" class="${over ? 'over' : ''}"></i><em style="left:${BOTTLENECK * 100}%"></em></span><span class="bv">${over ? '▲ ' : ''}${pct(r.v)}</span></${clickable ? 'button' : 'div'}>`;
    }).join('')}</div>`;
  }

  function zoneRows() {
    const { R, M, L } = ctx;
    return L.zones.filter((z) => z.capa).map((z) => {
      const o = occupancyAt(R, z.id, ctx.clock.t);
      return `<tr><td><button class="link" data-act="zone" data-id="${esc(z.id)}">${esc(z.name)}</button></td><td>${o === null ? '—' : pct(o)}</td><td>${M.cube[z.id] !== undefined ? pct(M.cube[z.id]) : '—'}</td></tr>`;
    }).join('');
  }

  async function runScenarios() {
    if (st.running) return;
    st.running = true;
    const btn = el.querySelector('#scen-run');
    btn.disabled = true;
    const base = overridesOf(ctx.L, ctx.R.assumptions);
    const out = [];
    st.scen = { rows: out, done: false };
    for (const lv of ctx.L.volumes.levels) {
      el.querySelector('#scen-out').innerHTML = `<div class="notice">Running level ${lv.level} (${Math.round(lv.factor * 100)}%)… ${out.length}/${ctx.L.volumes.levels.length}</div>`;
      await new Promise((r) => setTimeout(r, 30)); // let the progress paint
      out.push(volumeLevel(ctx.L, base, lv.level));
    }
    st.scen.done = true;
    st.running = false;
    btn.disabled = false;
    renderScen();
  }

  function renderScen() {
    const rows = st.scen.rows;
    const first = rows.find((r) => r.core.packingUtilization > BOTTLENECK);
    const maxTp = Math.max(...rows.map((r) => r.core.dailyThroughput));
    const plateau = rows.find((r) => r.core.dailyThroughput === maxTp);
    const capped = plateau !== rows[rows.length - 1] || rows.length === 1 ? plateau : null;
    const st0 = (r) => ctx.M.stations.find((s) => s.id === r.packingBottleneck)?.label || r.packingBottleneck;
    el.querySelector('#scen-out').innerHTML = `
      <table class="tbl"><thead><tr><th>Level</th><th>Volume</th><th>Packing</th><th>Throughput</th><th>Line dwell, min</th><th>Backlog</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r === first ? 'hl' : ''}"><td>${r.level}</td><td>${Math.round(r.factor * 100)}%</td><td>${r.core.packingUtilization > BOTTLENECK ? '▲ ' : ''}${pct(r.core.packingUtilization)}</td><td>${r.core.dailyThroughput}</td><td>${r.dwellByGroup['Line staging'] ? (r.dwellByGroup['Line staging'].avg / 60).toFixed(1) : '—'}</td><td>${r.backlog}</td></tr>`).join('')}
      </tbody></table>
      <div class="notice">${capped ? `Throughput tops out at <b>${maxTp} large boxes</b> from level ${capped.level} (${Math.round(capped.factor * 100)}%) — more volume after that only grows the backlog. ` : `Throughput keeps growing up to level ${rows[rows.length - 1].level}. `}${first ? `The busiest packing station crosses ${Math.round(BOTTLENECK * 100)}% at <b>level ${first.level} (${Math.round(first.factor * 100)}%)</b>: ${esc(st0(first))} ${pct(first.core.packingUtilization)}.` : `No packing station crosses ${Math.round(BOTTLENECK * 100)}%.`}</div>
      <div class="small muted">Fictional data. Each level is a full re-run of the day (deterministic); the day on screen is unchanged.</div>`;
  }

  /** live parts: current hour, zone occupancy (a few times per second at most). */
  function tick(force = false) {
    const t = ctx.clock.t;
    const h = Math.floor(t / 3600);
    if (force || h !== st.lastHour) {
      st.lastHour = h;
      el.querySelectorAll('.hours .bar').forEach((b) => b.classList.toggle('now', Number(b.dataset.h) === h));
    }
    const now = performance.now();
    if (force || now - st.lastLive > 500) {
      st.lastLive = now;
      const zb = el.querySelector('#zone-occ');
      if (zb && ctx.isTabVisible('analysis')) { const html = zoneRows(); if (zb.innerHTML !== html) zb.innerHTML = html; }
    }
  }

  return {
    setResult() { render(); },
    tick, setHeat, runScenarios,
    get scenarios() { return st.scen; },
  };
}
