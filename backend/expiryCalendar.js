// ─── F&O expiry calendar ─────────────────────────────────────────────────────
//
// Derives NSE monthly derivatives-expiry sessions from a trading calendar.
//
// Deliberately MONTHLY ONLY. The monthly rule — last Thursday of the month,
// pulled back to the previous trading session when that Thursday is a holiday —
// has been stable for years. The WEEKLY rule has not: NSE has moved weekly
// expiries between weekdays and between indices several times, so hardcoding a
// weekday here would encode a guess that silently goes stale. If weekly expiry
// is wanted, take it from an instrument feed that states it rather than from a
// rule in this file.
//
// The monthly rule is still an assumption, so `verifyAgainstVolume` exists to
// check it against evidence: expiry sessions carry unmistakably heavy cash-market
// turnover, so if the derived dates are right they should sit far above a normal
// session. A rule that cannot be checked is a rule that quietly rots.

const EXPIRY_WEEKDAY = 4; // Thursday (0 = Sunday)

const weekdayOf = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const monthKey = (iso) => iso.slice(0, 7);

/**
 * Last EXPIRY_WEEKDAY of a month, by arithmetic rather than by looking at
 * traded sessions. Needed to look FORWARD: a month still in progress has no
 * traded last-Thursday yet, so a calendar-derived answer would name an earlier
 * Thursday as the expiry. Holidays are unknowable in advance, so a projected
 * date can still shift a session earlier — callers say so.
 */
function lastThursdayOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this
  while (d.getUTCDay() !== EXPIRY_WEEKDAY) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const addMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * Monthly expiry sessions within `calendar` (sorted YYYY-MM-DD trading dates).
 *
 * For each month: the last session falling on EXPIRY_WEEKDAY. If the month has
 * none — the last Thursday was a holiday, so it is absent from the calendar —
 * fall back to the last session strictly before that Thursday, which is what the
 * exchange does.
 *
 * The final month is skipped unless the calendar extends past its expiry, since
 * a month still in progress has no settled answer.
 */
function monthlyExpiries(calendar) {
  if (!Array.isArray(calendar) || !calendar.length) return [];
  const byMonth = new Map();
  for (const d of calendar) {
    if (!byMonth.has(monthKey(d))) byMonth.set(monthKey(d), []);
    byMonth.get(monthKey(d)).push(d);
  }

  // A month still in progress has no settled expiry: its last traded Thursday
  // so far may simply be the second-to-last of the month. Including it would
  // report, say, 23 July as July's expiry on the 27th, three days before the
  // real one. Drop the trailing month unless the calendar already runs past it.
  const last = calendar[calendar.length - 1];
  const lastKey = monthKey(last);
  if (last < lastThursdayOf(lastKey)) byMonth.delete(lastKey);

  const out = [];
  for (const [, days] of byMonth) {
    const sorted = [...days].sort();
    const thursdays = sorted.filter(d => weekdayOf(d) === EXPIRY_WEEKDAY);
    if (thursdays.length) {
      const last = thursdays[thursdays.length - 1];
      // A Thursday in the final week is the expiry. An earlier one only counts
      // if the month genuinely ends before another Thursday could occur — which
      // the calendar already tells us, since it holds every traded session.
      out.push(last);
      continue;
    }
    // No Thursday traded at all this month (short stub month, or every Thursday
    // a holiday): the last session of the month stands in.
    if (sorted.length) out.push(sorted[sorted.length - 1]);
  }
  return out.sort();
}

/**
 * The next expiry on or after `from`.
 *
 * Looks in the traded calendar first — if the calendar already runs past this
 * month's expiry, that date is settled and any holiday shift is baked in.
 * Otherwise the date is PROJECTED arithmetically, because the sessions that
 * would prove it have not happened yet. Projected dates carry `projected: true`
 * and can still move a session earlier if the exchange closes that Thursday.
 *
 * `sessionsAway` is counted in traded sessions where the calendar reaches, which
 * is what a trader actually acts on; beyond it, it falls back to null rather
 * than inventing a count over days that may not trade.
 */
function nextExpiry(calendar, from) {
  const settled = monthlyExpiries(calendar).find(d => d >= from);
  if (settled) {
    return {
      date: settled,
      projected: false,
      sessionsAway: calendar.filter(d => d >= from && d < settled).length,
    };
  }

  let ym = monthKey(from);
  for (let i = 0; i < 24; i++) {
    const cand = lastThursdayOf(ym);
    if (cand >= from) {
      const known = calendar.filter(d => d >= from && d < cand);
      return {
        date: cand,
        projected: true,
        // Only meaningful while the traded calendar still covers the span.
        sessionsAway: calendar.length && calendar[calendar.length - 1] >= cand ? known.length : null,
      };
    }
    ym = addMonth(ym);
  }
  return null;
}

/**
 * Classify each session: is it an expiry, and how many sessions from one.
 * `offset` is negative before an expiry and positive after (0 = expiry day).
 */
function classifySessions(calendar, { window = 3 } = {}) {
  const expiries = new Set(monthlyExpiries(calendar));
  const idxOf = new Map(calendar.map((d, i) => [d, i]));
  const expiryIdx = [...expiries].map(d => idxOf.get(d)).filter(i => i != null).sort((a, b) => a - b);

  return calendar.map((date, i) => {
    let nearest = null;
    for (const e of expiryIdx) {
      const off = i - e;
      if (nearest == null || Math.abs(off) < Math.abs(nearest)) nearest = off;
    }
    return {
      date,
      isExpiry: expiries.has(date),
      offset: nearest,
      inExpiryWindow: nearest != null && Math.abs(nearest) <= window,
    };
  });
}

/**
 * Evidence check on the monthly rule.
 *
 * Compares median cash-market turnover on derived expiry sessions against every
 * other session. Expiry days are heavy — rollover and settlement both land — so
 * a ratio near 1.0 means the derived dates are probably NOT expiries and the
 * rule in this file has drifted from what the exchange does.
 *
 * @param turnoverByDate  Map/object of YYYY-MM-DD -> total traded value
 */
function verifyAgainstVolume(calendar, turnoverByDate, { minRatio = 1.1 } = {}) {
  const get = (d) => (turnoverByDate instanceof Map ? turnoverByDate.get(d) : turnoverByDate?.[d]);
  const expiries = new Set(monthlyExpiries(calendar));
  const on = [], off = [];
  for (const d of calendar) {
    const v = get(d);
    if (!Number.isFinite(v)) continue;
    (expiries.has(d) ? on : off).push(v);
  }
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const onMed = median(on), offMed = median(off);
  const ratio = onMed != null && offMed ? onMed / offMed : null;
  return {
    expirySessions: on.length,
    otherSessions: off.length,
    medianTurnoverOnExpiry: onMed,
    medianTurnoverOtherwise: offMed,
    ratio: ratio == null ? null : +ratio.toFixed(3),
    // Below the floor the rule is not carrying its weight — report it rather
    // than let a stale weekday assumption quietly mislabel every month.
    looksRight: ratio != null && ratio >= minRatio,
  };
}

module.exports = {
  EXPIRY_WEEKDAY, monthlyExpiries, nextExpiry, classifySessions, verifyAgainstVolume,
};
