// T8: Lot Trace tab (F-09, S4). The trace replay has no clock of its own: it rides the shared
// clock of the bottom bar, so play/pause, speed and scrubbing all apply (TRD 1.5, D-34).
import { idPatterns } from './ids.js';
import { hms } from './scenedata.js';
import { esc } from './ui.js';

const KIND_LABEL = { rmPallet: 'raw-material pallet', magazine: 'magazine', smallBox: 'small box', midBox: 'mid box', largeBox: 'large box (pallet)' };
const ID_LABEL = { po: 'PO', grDoc: 'GR document', batch: 'Batch', barcode: 'Barcode', lot: 'Lot', transfer: 'Transfer', magazine: 'Magazine', smallBox: 'Small box', midBox: 'Mid box', largeBox: 'Large box' };

/** Index of the last timeline event at or before t (binary search), -1 if none. */
export function eventIndexAt(timeline, t) {
  let lo = 0, hi = timeline.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (timeline[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Up to n example ids of the same kind as q (by id format), for the "not found" hint. */
export function similarIds(R, fmt, q, n = 3) {
  const pats = idPatterns(fmt);
  const kind = Object.keys(pats).find((k) => pats[k].test(String(q).trim().toUpperCase()));
  if (!kind) return { kind: null, ids: [] };
  const ids = [];
  for (const k of R.lineage.aliases.keys()) { if (pats[kind].test(k)) { ids.push(k); if (ids.length >= n) break; } }
  return { kind, ids };
}

export function buildTracePane(el, ctx) {
  const st = { tr: null, run: null, lastNow: -2 };
  el.innerHTML = `
    <form class="trace-form" id="trace-form" autocomplete="off">
      <input class="inp" id="trace-q" placeholder="Any ID: PO, batch, barcode, lot, box…" aria-label="ID to trace" spellcheck="false">
      <button class="btn primary" type="submit">Trace</button>
    </form>
    <div class="btns" id="trace-ex"></div>
    <div id="trace-out"></div>`;
  const q = el.querySelector('#trace-q'), out = el.querySelector('#trace-out');
  el.querySelector('#trace-form').addEventListener('submit', (e) => { e.preventDefault(); open(q.value); });

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'id') open(b.dataset.id);
    if (a === 'ev') { const ev = st.tr.timeline[Number(b.dataset.i)]; ctx.clock.set(ev.t); follow(true); }
    if (a === 'play') play();
    if (a === 'prev' || a === 'next') step(a === 'next' ? 1 : -1);
    if (a === 'follow') follow(!ctx.view.following);
    if (a === 'clear') clear();
  });

  function setExamples(R) {
    const ex = R.examples;
    const items = [['rawMaterial', 'Raw material, PO → line'], ['largeBox', 'Large box, pack-out → rack'], ['midBox', 'Mid box from re-input']];
    el.querySelector('#trace-ex').innerHTML = items.filter(([k]) => ex[k]).map(([k, t]) => `<button class="btn sm" data-act="id" data-id="${esc(ex[k])}" title="${esc(ex[k])}">${esc(t)}</button>`).join('');
  }

  function open(id) {
    const query = String(id ?? '').trim();
    q.value = query;
    st.run = null;
    if (!query) return;
    const R = ctx.R;
    const tr = R.lineage.trace(query);
    if (!tr) {
      st.tr = null;
      ctx.view.setTrace(null); follow(false);
      const sim = similarIds(R, ctx.L.idFormats, query);
      const ex = sim.ids.length ? sim.ids : Object.values(R.examples).filter(Boolean);
      out.innerHTML = `<div class="notice bad">No match for <b>${esc(query)}</b>${sim.kind ? ` (looks like a ${esc(ID_LABEL[sim.kind])})` : ''}.</div>
        <div class="small muted" style="margin-top:6px">${sim.ids.length ? `${esc(ID_LABEL[sim.kind])} IDs that exist today:` : 'Try one of these:'}</div>
        <div class="chips">${ex.map((x) => `<button class="chip" data-act="id" data-id="${esc(x)}">${esc(x)}</button>`).join('')}</div>`;
      return;
    }
    st.tr = tr;
    st.lastNow = -2;
    const R2 = ctx.R;
    ctx.view.setTrace((t) => {
      const i = eventIndexAt(tr.timeline, t);
      if (i < 0) return null;
      const e = tr.timeline[i];
      return { obj: e.obj, kind: R2.lineage.units.get(e.unit).kind, i };
    });
    render();
    ctx.select(null);
    play();
  }

  function render() {
    const tr = st.tr, u = tr.unit;
    const ids = u.attrs.ids || {};
    const idRows = Object.entries(ids).map(([k, v]) => `<button class="chip" data-act="id" data-id="${esc(v)}" title="${esc(k)}">${esc(k)} ${esc(v)}</button>`).join('');
    const first = tr.timeline[0], last = tr.timeline[tr.timeline.length - 1];
    out.innerHTML = `
      <div class="notice"><b>${esc(u.id)}</b> — ${esc(KIND_LABEL[u.kind] || u.kind)}${u.item ? ` · ${esc(u.item)}` : ''} · qty ${u.qty}
        ${tr.matches.length > 1 ? `<div class="small muted">${esc(tr.query)} matches ${tr.matches.length} units; showing the first.</div>` : ''}
        ${u.attrs.dummy ? '<div class="small muted">Opening stock: history before today omitted (dummy).</div>' : ''}
      </div>
      <div class="btns">
        <button class="btn sm primary" data-act="play" title="Replay from the first event on the shared clock">▶ Replay trace</button>
        <button class="btn sm" data-act="prev" title="Previous event">◀ Event</button>
        <button class="btn sm" data-act="next" title="Next event">Event ▶</button>
        <button class="btn sm" data-act="follow" id="trace-follow" aria-pressed="false">Follow camera</button>
        <button class="btn sm" data-act="clear">Clear</button>
      </div>
      <div class="follow-note" id="trace-note"></div>
      ${idRows ? `<h3>IDs of this unit</h3><div class="chips">${idRows}</div>` : ''}
      ${tr.matches.length > 1 ? `<h3>All matches (${tr.matches.length})</h3><div class="chips">${tr.matches.slice(0, 60).map((x) => `<button class="chip" data-act="id" data-id="${esc(x)}">${esc(x)}</button>`).join('')}${tr.matches.length > 60 ? ` <span class="small muted">+${tr.matches.length - 60}</span>` : ''}</div>` : ''}
      ${tr.contents.length ? `<h3>Contents (${tr.contents.length})</h3><div class="chips">${tr.contents.slice(0, 60).map((x) => `<button class="chip" data-act="id" data-id="${esc(x)}">${esc(x)}</button>`).join('')}${tr.contents.length > 60 ? ` <span class="small muted">+${tr.contents.length - 60}</span>` : ''}</div>` : ''}
      <h3>Timeline · ${hms(first.t)}–${hms(last.t)} · ${tr.timeline.length} events</h3>
      <ol class="tl" id="trace-tl">${tr.timeline.map((e, i) => `<li data-i="${i}"><button data-act="ev" data-i="${i}" title="Go to ${hms(e.t)}">
        <span class="tm">${hms(e.t)}</span><span class="st">${esc(e.step)}${e.unit !== u.id ? `<span class="role">${esc(e.role === 'container' ? 'in ' : e.role === 'origin' ? 'from ' : 'then ')}${esc(e.unit)}</span>` : ''}</span>
        <span class="tx">${esc([...new Set([e.tx, e.sys, e.loc && `@ ${e.loc}`, e.res && `by ${e.res}`, e.note].filter(Boolean))].join(' · '))}</span></button></li>`).join('')}</ol>`;
    tick(true);
  }

  /** Replay: jump to the first event and play on the shared clock (bar speed applies). */
  function play() {
    const tr = st.tr;
    if (!tr) return;
    const first = tr.timeline.find((e) => e.t >= 0) || tr.timeline[0];
    const last = tr.timeline[tr.timeline.length - 1];
    st.run = { end: Math.min(last.t + 5, 86399) };
    ctx.clock.set(Math.max(0, first.t - 3));
    const p0 = ctx.view.objPos(first.obj);
    if (p0) ctx.view.focus(p0, { radius: 14, sec: 0 });
    follow(true);
    ctx.clock.play(true);
  }

  function step(dir) {
    const tr = st.tr;
    if (!tr) return;
    const i = eventIndexAt(tr.timeline, ctx.clock.t);
    let j = dir > 0 ? i + 1 : i - (i >= 0 && tr.timeline[i].t === ctx.clock.t ? 1 : 0);
    while (j > 0 && j < tr.timeline.length && tr.timeline[j].t === ctx.clock.t) j += dir;
    j = Math.max(0, Math.min(tr.timeline.length - 1, j));
    ctx.clock.set(tr.timeline[j].t);
    follow(true);
  }

  function follow(on) {
    ctx.view.setFollow(on, () => tick(true));
    tick(true);
  }

  function clear() {
    st.tr = null; st.run = null;
    ctx.view.setTrace(null); ctx.view.setFollow(false);
    out.innerHTML = ''; q.value = '';
  }

  /** Called every frame by the app (cheap unless the current event changed). */
  function tick(force = false) {
    const tr = st.tr;
    if (!tr) return;
    const t = ctx.clock.t;
    if (st.run && t >= st.run.end && ctx.clock.playing) { ctx.clock.play(false); st.run = null; }
    const i = eventIndexAt(tr.timeline, t);
    const fb = out.querySelector('#trace-follow');
    if (fb) { const f = ctx.view.following; fb.classList.toggle('on', f); fb.setAttribute('aria-pressed', String(f)); }
    const note = out.querySelector('#trace-note');
    if (note) {
      const first = tr.timeline[0];
      const txt = t < first.t ? `Before the first event (${hms(first.t)}). ` : '';
      const s = `${txt}Replay uses the bottom bar: ${ctx.clock.speed}× · ${ctx.clock.playing ? 'playing' : 'paused'} · drag the time slider to scrub.${ctx.view.following ? '' : ' Camera is free (press Follow camera).'}`;
      if (note.textContent !== s) note.textContent = s;
    }
    if (i === st.lastNow && !force) return;
    st.lastNow = i;
    const lis = out.querySelectorAll('#trace-tl li');
    lis.forEach((li, k) => { li.classList.toggle('now', k === i); li.classList.toggle('future', k > i); });
    if (lis[i] && ctx.isTabVisible('trace')) lis[i].scrollIntoView({ block: 'nearest' });
  }

  return {
    setResult(R) { setExamples(R); if (st.tr) open(st.tr.query); },
    open, tick, clear,
    get active() { return st.tr; },
    get running() { return !!st.run; },
  };
}
