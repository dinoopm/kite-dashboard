// ─── NSE display numbers → stored numbers ────────────────────────────────────
//
// What broke Market Data Sync on 2026-11-02: NSE's live-analysis endpoints
// switched quantity and turnover from numbers to DISPLAY strings —
// "109.95 L", "2,759.40 Cr" — and Postgres rejected "60.62 L" as a bigint.
// Both movers scrapers threw at the upsert and wrote nothing, which is why the
// failure was fast and why only those two steps went red: the other scrapers
// read endpoints that did not change.
//
// Two things matter beyond reading the suffix:
//
// · The UNIT the column already holds. Quantities are stored as whole shares.
//   Turnover has always been stored in rupees LAKHS — ADANIENT on 2026-10-30:
//   ltp 2579.4 × 1,035,104 shares = 2.67e9 rupees, stored as 26,697.5. Parsing
//   "289.14 Cr" to rupees and writing it would have put two scales in one
//   column from Nov 3 onwards with nothing to tell them apart, so each field
//   converts to its column's unit explicitly.
//
// · An unrecognised format must fail LOUD. A silent null would have produced
//   empty fields under a green run, discovered weeks later as a hole. Throwing
//   names the offending value in the job log instead — and it caught "72.88 K"
//   on its first real run, a suffix the first payload sample had not shown.

// K arrived the same day as L and Cr — values under a lakh render as "72.88 K" —
// and was only seen because an unknown suffix throws: the first sample of 40
// rows happened to contain none.
const SUFFIX = {
  k: 1e3, thousand: 1e3,
  l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7,
};

/** A value in base units (shares or rupees), or null for NSE's placeholders. */
function parseNseNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  const s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '-') return null;

  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  const mult = m ? (m[2] ? SUFFIX[m[2].toLowerCase()] : 1) : undefined;
  if (!m || mult === undefined) throw new Error(`unrecognised NSE number "${v}"`);

  // Rounded to the hundredth of a base unit: 109.95 × 1e5 is not exactly
  // 10,995,000 in floating point, and a share count must not drift by 2e-9.
  return Math.round(Number(m[1]) * mult * 100) / 100;
}

/** Whole shares, from a legacy number or a display string. */
function toShares(v) {
  const n = parseNseNumber(v);
  return n == null ? null : Math.round(n);
}

/**
 * Rupees lakhs — the unit turnover has always been stored in.
 *
 * A NUMBER is the legacy payload and is already lakhs, so it passes through.
 * A STRING is the new display format and is converted from rupees.
 */
function toLakhs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const rupees = parseNseNumber(v);
  return rupees == null ? null : rupees / 1e5;
}

module.exports = { parseNseNumber, toShares, toLakhs };
