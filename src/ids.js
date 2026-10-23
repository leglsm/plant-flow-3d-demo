// ID generation (R6): sequential counters only — never the schedule RNG, so changing an
// ID format can never change the animation. Today's ids and previous-day (dummy) ids use
// separate number ranges so they can never collide.
import { pad } from './geom.js';

export function makeIds(fmt) {
  const c = {};
  const next = (k, base) => (c[k] = (c[k] ?? base) + 1);
  const d = fmt.dateCode;
  const prev = String(+d - 1);
  return {
    po: () => fmt.po.prefix + pad(next('po', 12000000), fmt.po.digits),
    grDoc: () => fmt.grDoc.prefix + pad(next('gr', 1200000), fmt.grDoc.digits),
    batch: () => fmt.batch.prefix + d + pad(next('batch', 0), fmt.batch.digits),
    barcode: () => fmt.barcode.prefix + pad(+d * 10000 + next('sb', 0), fmt.barcode.digits),
    barcodePrev: () => fmt.barcode.prefix + pad(+prev * 10000 + next('sbPrev', 0), fmt.barcode.digits),
    lotRM: () => fmt.lot.prefix + d + pad(next('lotRM', 0), fmt.lot.digits),
    lotRMPrev: () => fmt.lot.prefix + prev + pad(next('lotRMPrev', 0), fmt.lot.digits),
    lotFG: () => fmt.lot.prefix + d + pad(next('lotFG', 50000), fmt.lot.digits),
    lotFGPrev: () => fmt.lot.prefix + prev + pad(next('lotFGPrev', 50000), fmt.lot.digits),
    transfer: () => fmt.transfer.prefix + pad(next('st', 80000000), fmt.transfer.digits),
    magazine: () => fmt.magazine.prefix + pad(next('mz', 10000), fmt.magazine.digits),
    magazineRe: () => fmt.magazine.prefix + pad(next('mzRe', 50000), fmt.magazine.digits),
    smallBox: () => fmt.smallBox.prefix + pad(next('sbx', 100000), fmt.smallBox.digits),
    smallBoxPrev: () => fmt.smallBox.prefix + pad(next('sbxPrev', 0), fmt.smallBox.digits),
    midBox: () => fmt.midBox.prefix + pad(next('mbx', 10000), fmt.midBox.digits),
    midBoxPrev: () => fmt.midBox.prefix + pad(next('mbxPrev', 0), fmt.midBox.digits),
    largeBox: () => fmt.largeBox.prefix + pad(next('lbx', 1000), fmt.largeBox.digits),
    largeBoxPrev: () => fmt.largeBox.prefix + pad(next('lbxPrev', 0), fmt.largeBox.digits),
  };
}

/** Regex per id kind, built from idFormats (for validation / display). */
export function idPatterns(fmt) {
  const esc = (s) => s.replace(/[-]/g, '\\-');
  const n = (k) => `\\d{${fmt[k].digits}}`;
  return {
    po: new RegExp(`^${fmt.po.prefix}${n('po')}$`),
    grDoc: new RegExp(`^${fmt.grDoc.prefix}${n('grDoc')}$`),
    batch: new RegExp(`^${fmt.batch.prefix}\\d{6}${n('batch')}$`),
    barcode: new RegExp(`^${fmt.barcode.prefix}${n('barcode')}$`),
    lot: new RegExp(`^${fmt.lot.prefix}\\d{6}${n('lot')}$`),
    transfer: new RegExp(`^${fmt.transfer.prefix}${n('transfer')}$`),
    magazine: new RegExp(`^${esc(fmt.magazine.prefix)}${n('magazine')}$`),
    smallBox: new RegExp(`^${esc(fmt.smallBox.prefix)}${n('smallBox')}$`),
    midBox: new RegExp(`^${esc(fmt.midBox.prefix)}${n('midBox')}$`),
    largeBox: new RegExp(`^${esc(fmt.largeBox.prefix)}${n('largeBox')}$`),
  };
}
