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
