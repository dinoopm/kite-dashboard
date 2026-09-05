// ─── Period-on-period change pills ───────────────────────────────────────────
//
// Extracted from Instrument.jsx so the rules can be tested. The rule that
// matters: a percentage change is only meaningful from a POSITIVE base.
//
// Tata Power's net profit went −₹160 Cr → ₹334 Cr and the old code, dividing by
// |prev|, rendered "↑308.8%" in deep green. Read at a glance that says the
// quarter tripled; what actually happened is the company stopped losing money.
// The same arithmetic turns any return to profit into a spectacular-looking
// number whose size depends only on how small the previous loss was.
//
// So when either side is negative we describe the transition instead, and emit
// no number at all.

const GREEN_SOFT = '#34d399';
const GREEN = '#10b981';
const GREEN_DEEP = '#059669';
const RED_SOFT = '#fca5a5';
const RED = '#ef4444';
const RED_DEEP = '#dc2626';

// Bigger moves get louder colours and heavier type.
function intensity(abs, positive) {
  if (abs < 5) return { color: positive ? GREEN_SOFT : RED_SOFT, weight: 700 };
  if (abs < 15) return { color: positive ? GREEN : RED, weight: 700 };
  return { color: positive ? GREEN_DEEP : RED_DEEP, weight: 800 };
}

/**
 * Qualitative pill for any comparison involving a negative value, or null when
 * both sides are positive and ordinary percentage maths applies.
 *
 * `words` lets the cash-flow table say outflow/inflow where the P&L table says
 * loss/profit — same rule, different vocabulary.
 */
export function signChangePill(curr, prev, words = { neg: 'loss', pos: 'profit' }) {
  if (prev >= 0 && curr >= 0) return null;
  if (prev < 0 && curr >= 0) {
    return { label: `${words.neg} → ${words.pos}`, color: GREEN_DEEP, weight: 700, qualitative: true };
  }
  if (prev >= 0 && curr < 0) {
    return { label: `${words.pos} → ${words.neg}`, color: RED_DEEP, weight: 800, qualitative: true };
  }
  // Both negative: what moved is the size of the shortfall, and a shrinking one
  // is an improvement even though the number went up.
  const widened = curr < prev;
  return {
    label: `${words.neg} ${widened ? 'wider' : 'narrower'}`,
    color: widened ? RED_DEEP : GREEN,
    weight: 700,
    qualitative: true,
  };
}

/** Growth pill: ↑/↓ percentage, or a qualitative label when a base is negative. */
export function growthPill(curr, prev, words) {
  if (curr == null || prev == null || prev === 0) return null;
  const signChange = signChangePill(curr, prev, words);
  if (signChange) return signChange;
  const pct = ((curr - prev) / prev) * 100;
  const positive = pct >= 0;
  const abs = Math.abs(pct);
  return { label: `${positive ? '↑' : '↓'}${abs.toFixed(1)}%`, ...intensity(abs, positive) };
}

/**
 * Expenses invert: rising is bad. Sign carries direction instead of an arrow,
 * because an up-arrow beside a red number reads as a contradiction when every
 * other row treats ↑ as good.
 */
export function expensePill(curr, prev) {
  const p = growthPill(curr, prev);
  if (!p) return null;
  // Qualitative pills carry no percentage to re-sign and their polarity is
  // already right — pass them through rather than parsing the label.
  if (p.qualitative) return p;
  const rising = p.label.startsWith('↑');
  const abs = parseFloat(p.label.slice(1));
  return { ...p, label: `${rising ? '+' : '−'}${abs.toFixed(1)}%`, ...intensity(abs, !rising) };
}

/** Margins move in percentage POINTS; a relative change would be nonsense. */
export function marginPill(curr, prev) {
  if (curr == null || prev == null) return null;
  const diff = curr - prev;
  const positive = diff >= 0;
  const abs = Math.abs(diff);
  let color, weight = abs >= 5 ? 800 : 700;
  if (abs < 1) color = positive ? GREEN_SOFT : RED_SOFT;
  else if (abs < 5) color = positive ? GREEN : RED;
  else color = positive ? GREEN_DEEP : RED_DEEP;
  return { label: `${positive ? '+' : '−'}${abs.toFixed(1)} pp`, color, weight };
}

/** Cash-flow wording: investing and financing lines are negative by nature. */
export const cashflowPill = (curr, prev) =>
  growthPill(curr, prev, { neg: 'outflow', pos: 'inflow' });

/**
 * The Net Profit YoY card on the P&L snapshot: latest change, plus how often
 * profit improved across the visible window.
 *
 * Extracted for the same reason as the pills, and it obeys the same rule. The
 * card used to divide by |prev| and print the result whatever the signs were,
 * so a ₹64 Cr loss narrowing to a ₹27 Cr loss showed as "↑ +57.8%" in green
 * directly above a row that correctly read "loss → narrower" — for a quarter
 * the company lost money. `pill` is set instead of `latest` whenever either
 * side is negative, and the caller renders the transition with no number.
 *
 * `wins` counts periods where net profit ROSE, which is one test that works
 * across a sign change and reduces to "pct > 0" when both sides are positive:
 * a narrowing loss improved, a slide into loss did not. Counting `pct > 0` off
 * the |prev| ratio scored a loss-making period as one that grew.
 *
 * `signChanges` lets the caller pick its verb: "grew" is wrong for a window
 * containing a loss, where "improved" is the honest word.
 *
 * @param pairs [{ curr, prev }] oldest → newest; the last entry is "latest".
 */
export function profitYoYSummary(pairs, words) {
  let wins = 0, considered = 0, latest = null, pill = null, signChanges = 0
  let latestCurr = null, latestPrev = null, magnitudePct = null
  pairs.forEach(({ curr, prev }, i) => {
    if (curr == null || prev == null || prev === 0) return
    considered += 1
    const signChange = signChangePill(curr, prev, words)
    if (signChange) signChanges += 1
    if (curr > prev) wins += 1
    if (i === pairs.length - 1) {
      pill = signChange
      latest = signChange ? null : ((curr - prev) / prev) * 100
      // When BOTH sides are negative there is a percentage worth showing — but
      // it measures the SIZE OF THE LOSS, not profit. A ₹64 Cr loss becoming
      // ₹27 Cr is the loss down 57.8%; calling that "net profit +57.8%" was the
      // original defect. Same arithmetic, honest subject, so the caller labels
      // it "loss down/up" and never as growth.
      //
      // Left null across a sign flip on purpose: from −64 to +141 the base
      // changes sign, so no percentage describes the move at all — only the two
      // amounts do.
      if (curr < 0 && prev < 0) {
        magnitudePct = ((Math.abs(prev) - Math.abs(curr)) / Math.abs(prev)) * 100
      }
      // The two amounts, always. Refusing the ratio is not a reason to withhold
      // the magnitude: "loss narrower" alone says less than the card did before,
      // and −27 against −64 is the fact the percentage was a bad summary OF.
      // Absolute figures carry no sign trap, so they are safe where the ratio
      // is not, and the caller renders them under the qualitative label.
      latestCurr = curr
      latestPrev = prev
    }
  })
  return { wins, considered, latest, pill, signChanges, latestCurr, latestPrev, magnitudePct }
}
