// Lot lineage (F-08, F-09, R5, R10–R12). Pure data structure filled by the schedule at the
// same place it creates the work, so trace position = animation position.
//
// unit:  {id, kind, t0, item, qty, attrs, ev[], from[], to[], into[{id,t0,t1}], contents[]}
// event: {t, unit, step, tx, sys, loc, sloc, res, obj:{type:'pal'|'res'|'pt', id|p}, note?}

export class Lineage {
  constructor() {
    this.units = new Map();
    this.aliases = new Map(); // alias id -> [unit ids]
    this.events = [];
  }

  unit(kind, id, t, { item = null, qty = 1, attrs = {} } = {}) {
    if (this.units.has(id)) throw new Error(`lineage: duplicate unit id ${id}`);
    const u = { id, kind, t0: t, item, qty, attrs, ev: [], from: [], to: [], into: [], contents: [] };
    this.units.set(id, u);
    this.alias(id, id, 'self');
    return u;
  }

  alias(aliasId, unitId, kind) {
    const list = this.aliases.get(aliasId);
    if (!list) this.aliases.set(aliasId, [unitId]);
    else if (!list.includes(unitId)) list.push(unitId);
    const u = this.units.get(unitId);
    if (kind && kind !== 'self') (u.attrs.ids ||= {})[kind] = aliasId;
  }

  ev(unitId, e) {
    const u = this.units.get(unitId);
    if (!u) throw new Error(`lineage: event for unknown unit ${unitId}`);
    const full = { unit: unitId, tx: '', sys: '', loc: '', sloc: '', res: '', ...e };
    if (!full.obj) throw new Error(`lineage: event without 3D target (${unitId} ${e.step})`);
    u.ev.push(full);
    this.events.push(full);
    return full;
  }

  /** child is made from parents (magazine -> small box, small box -> magazine). */
  derive(childId, parentIds) {
    const c = this.units.get(childId);
    for (const p of parentIds) { c.from.push(p); this.units.get(p).to.push(childId); }
  }

  /** children are put into parent (small -> mid -> large box). */
  pack(parentId, childIds, t) {
    const p = this.units.get(parentId);
    for (const id of childIds) {
      this.units.get(id).into.push({ id: parentId, t0: t, t1: null });
      p.contents.push(id);
    }
  }

  /** children are taken out of parent at t. */
  unpack(parentId, t) {
    const p = this.units.get(parentId);
    p.attrs.unpackedAt = t;
    for (const id of p.contents) {
      const iv = this.units.get(id).into.find((x) => x.id === parentId && x.t1 === null);
      if (iv) iv.t1 = t;
    }
  }

  resolve(anyId) {
    const q = String(anyId ?? '').trim();
    return this.aliases.get(q) || this.aliases.get(q.toUpperCase()) || [];
  }

  /** own events + container events while contained (recursive), within [lo, hi). */
  _withContainers(u, lo, hi, role, depth = 0) {
    const out = u.ev.filter((e) => e.t >= lo && e.t < hi).map((e) => ({ ...e, role }));
    if (depth > 6) return out;
    for (const iv of u.into) {
      const a = Math.max(lo, iv.t0), b = Math.min(hi, iv.t1 ?? Infinity);
      if (a >= b && !(iv.t0 === iv.t1)) continue;
      const parent = this.units.get(iv.id);
      out.push(...this._withContainers(parent, a, b, role === 'self' ? 'container' : role, depth + 1));
    }
    return out;
  }

  /** representative origin path before t (R10 ③). */
  _origin(u, t, depth = 0) {
    if (depth > 8) return [];
    const rep = u.from[0] ?? (u.contents.length && !u.from.length && u.kind !== 'rmPallet' ? u.contents[0] : null);
    if (!rep) return [];
    const r = this.units.get(rep);
    return [...this._withContainers(r, -Infinity, t, 'origin').filter((e) => e.unit === r.id || e.t < t), ...this._origin(r, r.t0, depth + 1)]
      .filter((e) => e.t <= t);
  }

  /** representative path after the unit ends (R10 ④). */
  _after(u, depth = 0) {
    if (depth > 8) return [];
    if (u.to.length) {
      const r = this.units.get(u.to[0]);
      return [...this._withContainers(r, -Infinity, Infinity, 'after'), ...this._after(r, depth + 1)];
    }
    if (u.attrs.unpackedAt !== undefined && u.contents.length) {
      const r = this.units.get(u.contents[0]);
      const t = u.attrs.unpackedAt;
      return [...this._withContainers(r, t, Infinity, 'after'), ...this._after(r, depth + 1)];
    }
    return [];
  }

  /**
   * Trace (R10). Returns null for unknown ids. Representative unit = first match;
   * all matches and all contents are returned as chips.
   */
  trace(anyId) {
    const ids = this.resolve(anyId);
    if (!ids.length) return null;
    const u = this.units.get(ids[0]);
    const all = [
      ...this._origin(u, u.t0),
      ...this._withContainers(u, -Infinity, Infinity, 'self'),
      ...this._after(u),
    ].sort((a, b) => a.t - b.t || roleRank(a.role) - roleRank(b.role));
    const seen = new Set(), timeline = [];
    for (const e of all) {
      const k = `${e.t}|${e.unit}|${e.step}`;
      if (seen.has(k)) continue;
      seen.add(k); timeline.push(e);
    }
    return {
      query: String(anyId).trim(), unit: u, matches: ids,
      contents: u.contents.slice(), timeline,
    };
  }

  /** 3D target at t (R11): obj of the last timeline event at or before t. */
  objAt(trace, t) {
    let last = null;
    for (const e of trace.timeline) { if (e.t <= t) last = e; else break; }
    return last ? last.obj : null;
  }
}

const roleRank = (r) => ({ origin: 0, container: 1, self: 1, after: 2 }[r] ?? 1);
