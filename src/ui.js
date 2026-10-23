// T7: 3D Operations pane (drawer), Selection panel, units. DOM only; reads the run result.
import { DAY } from './schedule.js';
import { nextTaskAt, occupancyAt } from './metrics.js';
import { hms } from './scenedata.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function makeUnits() {
  const st = { ft: false };
  return {
    get ft() { return st.ft; },
    toggle() { st.ft = !st.ft; return st.ft; },
    len(m, d = 0) { return st.ft ? `${(m * 3.28084).toFixed(d)} ft` : `${m.toFixed(d)} m`; },
    xy(p) { const k = st.ft ? 3.28084 : 1; return `(${(p[0] * k).toFixed(1)}, ${(p[1] * k).toFixed(1)}) ${st.ft ? 'ft' : 'm'}`; },
  };
}

/** Drawer for the 3D Operations tab: layers, flows, zone jump, resource list. */
export function buildOpsPane(el, ctx) {
  const { L, view } = ctx;
  const layers = [['zones', 'Zones & floor marks'], ['racks', 'Racks'], ['pallets', 'Stored pallets'], ['wip', 'Work in progress'], ['equipment', 'Equipment'], ['resources', 'People & vehicles'], ['walls', 'Walls']];
  el.innerHTML = `
    <h3>Flows</h3>
    <label class="chk"><input type="checkbox" data-flow="A" checked> Flow A — raw material (offsite → line)</label>
    <label class="chk"><input type="checkbox" data-flow="B" checked> Flow B — finished goods (pack-out, re-input)</label>
    <h3>Layers</h3>
    <div class="grid2">${layers.map(([k, t]) => `<label class="chk"><input type="checkbox" data-layer="${k}" checked> ${t}</label>`).join('')}</div>
    <h3>Go to zone</h3>
    <div class="list" id="zone-list">${L.zones.map((z) => `<button class="row" data-zone="${esc(z.id)}">${esc(z.name)}<span class="k">${esc(z.id)}</span></button>`).join('')}</div>
    <h3>People & vehicles</h3>
    <div id="res-list"></div>`;
  el.querySelectorAll('[data-flow]').forEach((c) => c.addEventListener('change', () => view.setFlow(c.dataset.flow, c.checked)));
  el.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => view.setLayer(c.dataset.layer, c.checked)));
  el.querySelectorAll('[data-zone]').forEach((b) => b.addEventListener('click', () => {
    const z = L.zones.find((x) => x.id === b.dataset.zone);
    const span = Math.max(z.rect[2] - z.rect[0], z.rect[3] - z.rect[1]);
    view.focus([(z.rect[0] + z.rect[2]) / 2, (z.rect[1] + z.rect[3]) / 2], { radius: span * 0.6 });
    ctx.select({ kind: 'zone', id: z.id });
  }));
  return {
    setResult(R) {
      const groups = new Map();
      for (const [id, r] of Object.entries(R.resources)) {
        const g = r.type === 'machine' ? 'Equipment' : r.group;
        (groups.get(g) || groups.set(g, []).get(g)).push([id, r]);
      }
      el.querySelector('#res-list').innerHTML = [...groups].map(([g, list]) => `<div class="grp">${esc(g)}</div><div class="list">${list.map(([id, r]) =>
        `<button class="row" data-res="${esc(id)}">${esc(r.name)}<span class="k">${esc(r.role === 'Machine' ? 'machine' : `${r.role} · ${r.shift === 'all' ? '24h' : 'shift ' + r.shift}`)}</span></button>`).join('')}</div>`).join('');
      el.querySelectorAll('[data-res]').forEach((b) => b.addEventListener('click', () => {
        ctx.select({ kind: 'resource', id: b.dataset.res });
        const p = view.objPos({ type: 'res', id: b.dataset.res });
        if (p) view.focus(p, { radius: 14 });
      }));
    },
  };
}

/** Last slotLog entry for a slot at or before t -> {unit|null, item|null, opening}. */
function slotContent(R, slotId, t) {
  let last = null;
  for (const e of R.slotLog) { if (e.t > t) break; if (e.slot === slotId) last = e; }
  if (last) return last.d > 0 ? { unit: last.unit, opening: false } : null;
  const o = R.initialOcc.get(slotId);
  return o ? { unit: o.unit, item: o.item, opening: true } : null;
}

/** Selection panel (F-06). Re-rendered a few times per second while visible. */
export function buildSelection(el, ctx) {
  let cur = null, lastHtml = '';
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') ctx.select(null);
    if (b.dataset.act === 'goto') ctx.clock.set(Number(b.dataset.t));
    if (b.dataset.act === 'trace') ctx.openTrace(b.dataset.id);
    if (b.dataset.act === 'focus' && cur) { const p = ctx.view.objPos(objFor(cur)); if (p) ctx.view.focus(p, { radius: 14 }); }
  });

  function objFor(s) {
    if (!s) return null;
    if (s.kind === 'resource') return { type: 'res', id: s.id };
    if (s.kind === 'slot') return { type: 'pal', id: s.id };
    if (s.kind === 'zone') { const z = ctx.L.zones.find((x) => x.id === s.id); return { type: 'pt', p: [(z.rect[0] + z.rect[2]) / 2, (z.rect[1] + z.rect[3]) / 2] }; }
    if (s.kind === 'equipment') { const e = ctx.L.equipment.find((x) => x.id === s.id); return { type: 'pt', p: [(e.rect[0] + e.rect[2]) / 2, (e.rect[1] + e.rect[3]) / 2] }; }
    if (s.kind === 'point') return { type: 'pt', p: s.p };
    return null;
  }

  function render() {
    if (!cur) { el.hidden = true; lastHtml = ''; return; }
    const html = body(cur);
    if (html !== lastHtml) { el.innerHTML = html; lastHtml = html; }
    el.hidden = false;
  }

  function head(title, sub) {
    return `<div class="hd"><div><div class="ttl">${esc(title)}</div><div class="sub">${esc(sub)}</div></div><button class="icon" data-act="close" title="Close (Esc)" aria-label="Close">×</button></div>`;
  }
  const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  function body(s) {
    const { R, M, units } = ctx;
    const t = ctx.clock.t;
    if (s.kind === 'resource' || (s.kind === 'equipment' && R.tracks[s.id])) {
      const id = s.id, r = R.resources[id], m = M.perRes[id];
      const st = ctx.view.actorState(id) || {};
      const rt = ctx.L.resourceTypes.find((x) => x.id === r.type);
      const nt = nextTaskAt(R, id, t);
      const done = R.taskLog.filter((x) => x.res === id && x.t1 <= t).length;
      const carry = st.carry && typeof st.carry === 'string' ? st.carry : null;
      const shift = r.shift === 'all' ? '24 h' : r.shift === 'A' ? 'Shift A 06:00–18:00' : 'Shift B 18:00–06:00';
      return head(r.name, `${id} · ${r.role}${r.group ? ' · ' + r.group : ''}`) + kv([
        ['Now', st.seg ? `${esc(st.task)} <span class="muted">(${esc(st.phase)})</span>` : '<span class="muted">idle</span>'],
        carry ? ['Carrying', `<button class="link" data-act="trace" data-id="${esc(carry)}">${esc(carry)}</button>`] : (st.carry ? ['Carrying', `${esc(st.carry)} units`] : null),
        ['Next task', nt === null ? '<span class="muted">none today</span>' : `<button class="link" data-act="goto" data-t="${nt}">${hms(nt)}</button>`],
        ['Tasks', `${done} done · ${m.tasks} today`],
        ['Utilization', `${pct(m.util)} <span class="muted">of ${(m.available / 3600).toFixed(0)} h</span>`],
        r.type !== 'machine' ? ['Distance', `${units.len(m.distance.total)} <span class="muted">(${units.len(m.distance.loaded)} loaded)</span>`] : null,
        rt ? ['Speed', `${rt.speed} / ${rt.speedLoaded} m/s <span class="muted">empty / loaded</span>`] : null,
        rt ? ['Capacity', `${rt.capacity} ${esc(rt.capUnit)}`] : null,
        ['Shift', esc(shift)],
        ['Position', esc(units.xy(ctx.view.objPos({ type: 'res', id }) || [0, 0]))],
      ]) + `<div class="btns"><button class="btn sm" data-act="focus">Center view</button></div>`;
    }
    if (s.kind === 'slot') {
      const sl = ctx.view.slots.find((x) => x.id === s.id);
      const c = slotContent(R, s.id, t);
      const f = M.freq.get(s.id) || { puts: 0, picks: 0 };
      const z = ctx.L.zones.find((x) => x.id === sl.zone);
      return head(s.id, `${sl.kind === 'rack' ? `rack ${sl.row} · bay ${sl.bay} · level ${sl.level}` : `floor ${sl.row}`} · ${z ? z.name : sl.zone}`) + kv([
        ['Now', c ? (c.unit ? `<button class="link" data-act="trace" data-id="${esc(c.unit)}">${esc(c.unit)}</button>` : `${esc(c.item || 'pallet')} <span class="muted">(opening stock)</span>`) : '<span class="muted">empty</span>'],
        ['Puts today', String(f.puts)], ['Picks today', String(f.picks)],
        ['Slot', `${units.len(sl.w, 2)} × ${units.len(sl.d, 2)} × ${units.len(sl.h, 2)}`],
        ['Items', esc((sl.items || []).join(', ') || 'any')],
      ]);
    }
    if (s.kind === 'zone') {
      const z = ctx.L.zones.find((x) => x.id === s.id);
      const occ = occupancyAt(R, z.id, t);
      const n = ctx.view.slots.filter((x) => x.zone === z.id).length;
      return head(z.name, `${z.id} · ${z.cat}`) + kv([
        ['Occupancy', occ === null ? '<span class="muted">no storage positions</span>' : `${pct(occ)} <span class="muted">of ${n} positions</span>`],
        ['Capacity', z.capa ? `${z.capa} ${esc(z.capaUnit)} <span class="muted">(layout: ${z.capaCalc})</span>` : '<span class="muted">—</span>'],
        ['Size', `${units.len(z.rect[2] - z.rect[0])} × ${units.len(z.rect[3] - z.rect[1])}`],
        ['Source', esc(z.src)],
      ]);
    }
    if (s.kind === 'equipment') {
      const e = ctx.L.equipment.find((x) => x.id === s.id);
      return head(e.name, `${e.id} · ${e.type}`) + kv([
        ['Status', s.inactive ? 'not used in this setup' : 'in use'],
        ['Size', `${units.len(e.rect[2] - e.rect[0], 1)} × ${units.len(e.rect[3] - e.rect[1], 1)} × ${units.len(e.h, 1)}`],
        ['Source', esc(e.src)],
      ]);
    }
    return head('Point', 'floor') + kv([['Position', esc(units.xy(s.p))]]);
  }

  return {
    set(s) { cur = s; lastHtml = ''; ctx.view.setSelection(objFor(s)); render(); },
    get current() { return cur; },
    render,
  };
}

/** Bottom-bar status: shift + activity at t. */
export function phaseText(t, act) {
  const shift = t >= 21600 && t < 64800 ? 'Shift A' : 'Shift B';
  return `${shift} · ${act.moving} moving · ${act.working} working`;
}

export { DAY };
