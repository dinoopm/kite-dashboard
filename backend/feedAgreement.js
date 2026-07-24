// Feed-agreement check for the Alpaca price feeds.
//
// Why this exists: ALPACA_SNAPSHOT_FEED was once set to "iex", which is a
// partial-volume feed (~2-3% of trades). Its daily bar closes are IEX-only
// prints, not the official consolidated close — so the US instrument header
// showed INTC closing at 100.05 / -2.49% when the real close was
// 100.23 / -2.33%. Nothing failed: the app rendered a wrong number happily,
// and the Period Return card (fed by the bars feed) disagreed with the header
// (fed by the snapshot feed) on the same screen.
//
// No unit test on our own code could catch that — it is a configuration value
// that silently changes what the data means. What does catch it is asking the
// two feeds the same question and noticing they answer differently.
//
// Settled daily closes are the right probe: once a session is closed, every
// full-volume feed must report the identical official close. A material,
// repeated disagreement means at least one feed is not what we think it is.

// Two full-volume feeds reporting the same settled session must report the
// SAME official close — the tolerance here is for rounding, not for genuine
// price disagreement. A purely relative threshold is too permissive on
// high-priced stocks (0.05% of $300 is 15 cents, which would wave through a
// real feed mismatch), so a close must clear both bars to count as divergent.
const CLOSE_ABS_EPSILON = 0.011;  // just over a cent
const CLOSE_REL_EPSILON = 0.0001; // 0.01%

// A single divergent session can be a late correction or a halt. Requiring
// several keeps the check from crying wolf.
const MIN_DIVERGENT_SESSIONS = 2;

/**
 * Compare two sets of settled closes, pairing entries by `key`.
 *
 * The key is whatever makes two closes comparable. Pairing across dates for
 * one symbol and across symbols for one date are both valid probes; the
 * caller decides which, because the feeds are not accepted by the same
 * endpoints (delayed_sip serves snapshots but not bars, so a same-symbol
 * multi-session probe is impossible for it).
 *
 * @param {Array<{key: string, close: number}>} a  closes from one feed
 * @param {Array<{key: string, close: number}>} b  closes from the other feed
 * @returns {{compared: number, divergent: Array, worstPct: number, agrees: boolean}}
 *   `agrees` is true when the feeds are interchangeable for pricing. With
 *   nothing comparable it reports agrees:true — absence of evidence must not
 *   raise a false alarm about a feed that may be fine.
 */
function compareCloses(a, b) {
  const byKey = new Map();
  for (const row of a || []) {
    if (row && row.key != null && Number.isFinite(row.close)) {
      byKey.set(String(row.key), row.close);
    }
  }

  const divergent = [];
  let compared = 0;
  let worstPct = 0;

  for (const row of b || []) {
    if (!row || row.key == null || !Number.isFinite(row.close)) continue;
    const key = String(row.key);
    if (!byKey.has(key)) continue;

    const other = byKey.get(key);
    compared++;
    // Guard against a zero/absent reference price.
    if (!other) continue;

    const diffAbs = Math.abs(row.close - other);
    const diffPct = diffAbs / Math.abs(other);
    if (diffPct > worstPct) worstPct = diffPct;
    if (diffAbs > CLOSE_ABS_EPSILON && diffPct > CLOSE_REL_EPSILON) {
      divergent.push({ key, a: other, b: row.close, diffAbs, diffPct });
    }
  }

  return {
    compared,
    divergent,
    worstPct,
    agrees: divergent.length < MIN_DIVERGENT_SESSIONS,
  };
}

/**
 * Turn a comparison into an operator-readable finding, or null when the feeds
 * agree. Names both feeds so the message points at the setting to change.
 */
function describeDisagreement(result, { feedA, feedB, symbol }) {
  if (!result || result.agrees) return null;
  const worst = result.divergent
    .slice()
    .sort((x, y) => y.diffPct - x.diffPct)[0];
  return {
    scope: symbol,
    feedA,
    feedB,
    compared: result.compared,
    divergent: result.divergent.length,
    worstPct: +(result.worstPct * 100).toFixed(3),
    example: worst
      ? { key: worst.key, [feedA]: worst.a, [feedB]: worst.b }
      : null,
    message:
      `Alpaca feeds "${feedA}" and "${feedB}" report different settled closes for ${symbol} ` +
      `(${result.divergent.length} of ${result.compared} compared, worst ${(result.worstPct * 100).toFixed(3)}%). ` +
      `A partial-volume feed such as "iex" reports only its own prints, not the official ` +
      `consolidated close. Prices shown from that feed will be wrong. ` +
      `Check ALPACA_DATA_FEED and ALPACA_SNAPSHOT_FEED.`,
  };
}

module.exports = {
  compareCloses,
  describeDisagreement,
  CLOSE_ABS_EPSILON,
  CLOSE_REL_EPSILON,
  MIN_DIVERGENT_SESSIONS,
};
