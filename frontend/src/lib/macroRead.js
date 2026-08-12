// ─── Reading the macro monitor in words ──────────────────────────────────────
//
// Pure derivations over the /api/macro/monitor payload. No fetching, no JSX, so
// the wording is testable and a change to it fails a test rather than a
// screenshot.
//
// Everything here is DERIVED. That is the point: a hand-written summary of this
// panel got it wrong. On 2026-08-09 the plausible sentence was "inflation
// pressure, offset by a cooling labour market" — but the contributions were
// inflation +0.135, wages -0.150, labour -0.079. The main offset was wage
// moderation, and it was LARGER than the pressure, which is the actual reason
// the composite sits below zero. Prose that is not computed will drift from the
// numbers next to it.
//
// Nothing here may assert what a central bank will do. The vocabulary is
// pressure / offset / risk / compatible, and a test enforces it.

const REGIME_WORD = {
  cooling: 'Cooling',
  neutral: 'Neutral',
  reaccelerating: 'Re-accelerating',
  unknown: 'Unknown',
};

const POLICY_WORD = {
  'cut-compatible': 'Cut-compatible',
  'hold-compatible': 'Hold-compatible',
  'hike-risk': 'Hike-risk',
};

// Human names for the scored components. Longer than the payload keys because
// "Labour" alone does not say which direction is which.
const COMPONENT_LABEL = {
  inflation: 'Inflation pressure',
  labour: 'Labour-market cooling',
  wages: 'Wage pressure',
  expectations: 'Inflation expectations',
  oil: 'Oil / energy risk',
};

// What each component is called when it appears mid-sentence.
const COMPONENT_PHRASE = {
  inflation: 'core inflation',
  labour: 'hiring and unemployment',
  wages: 'wage growth',
  expectations: 'inflation expectations',
  oil: 'oil prices',
};

const n2 = (v) => (v == null || !Number.isFinite(v) ? null : v.toFixed(2));

/** Where the score sits, in words, so the number never has to be interpreted alone. */
function directionWord(score) {
  if (score == null || !Number.isFinite(score)) return 'No reading';
  const a = Math.abs(score);
  const dir = score < 0 ? 'cooling' : 're-accelerating';
  if (a < 0.10) return `Slightly ${dir}`;
  if (a < 0.25) return dir.charAt(0).toUpperCase() + dir.slice(1);
  if (a < 0.60) return `Firmly ${dir}`;
  return `Strongly ${dir}`;
}

/**
 * Confidence, with the reason it is not higher.
 *
 * Three percentages side by side make the reader find the weak one. Naming it
 * is the whole value: agreement at 0.34 means the sub-signals point in opposite
 * directions, which is a completely different situation from a genuinely calm
 * reading, and it is the number a glance is most likely to miss.
 */
function confidenceConstraint(confidence) {
  if (!confidence) return null;
  // Plain phrasing over precise phrasing: "mixed indicator signals" lands
  // immediately, where "indicators disagree (34%)" makes the reader work out
  // what 34% is a percentage OF before it means anything.
  const dims = [
    { key: 'agreement', v: confidence.agreement, text: 'Limited by mixed indicator signals' },
    { key: 'freshness', v: confidence.freshness, text: 'Limited by data behind its release schedule' },
    { key: 'completeness', v: confidence.completeness, text: 'Limited by missing series' },
  ].filter(d => Number.isFinite(d.v));
  if (!dims.length) return null;
  const worst = dims.reduce((a, b) => (b.v < a.v ? b : a));
  if (worst.v >= 0.75) return { key: null, text: 'All inputs fresh and broadly agreeing', value: worst.v };
  return { key: worst.key, text: worst.text, value: worst.v };
}

/**
 * The three lines a reader needs before any bar: what is pushing, what is
 * pulling the other way, and what could move it next.
 *
 * Derived from the contributions rather than written, and it routinely
 * disagrees with intuition — see the note at the top of this file.
 */
function signalTriad(monitor) {
  const contributions = (monitor?.composite?.contributions || [])
    .filter(c => Number.isFinite(c.contribution));
  const positive = contributions.filter(c => c.contribution > 0).sort((a, b) => b.contribution - a.contribution);
  const negative = contributions.filter(c => c.contribution < 0).sort((a, b) => a.contribution - b.contribution);
  const next = monitor?.releases?.next || null;

  return {
    pressure: positive[0]
      ? { key: positive[0].key, label: COMPONENT_LABEL[positive[0].key] || positive[0].key, value: positive[0].contribution }
      : null,
    offset: negative[0]
      ? { key: negative[0].key, label: COMPONENT_LABEL[negative[0].key] || negative[0].key, value: negative[0].contribution }
      : null,
    risk: next ? { title: next.title, date: next.date, daysAway: next.daysAway } : null,
  };
}

/**
 * Round contributions so the displayed values SUM to the displayed headline.
 *
 * The underlying arithmetic was never wrong — the raw contributions sum to the
 * composite to within 1e-12. The problem is purely that rounding each one
 * independently loses the identity a reader checks by eye. On 2026-08-10 the
 * cards read +0.14, -0.08, -0.15, -0.01, +0.05, which totals -0.05 against a
 * headline of -0.058.
 *
 * More decimal places does not fix this, which is worth stating because it is
 * the obvious first idea. The same values render as:
 *
 *   2dp  sum -0.05    headline -0.06
 *   3dp  sum -0.059   headline -0.058
 *   4dp  sum -0.0582  headline -0.0581
 *
 * Independent rounding can always drift; the error just moves to a smaller
 * decimal. The only way to guarantee the identity is to round to the headline's
 * total on purpose — the largest-remainder (Hare-Niemeyer) method: floor
 * everything, then hand the leftover units to whichever entries were rounded
 * down the hardest. Every displayed value stays within one unit of its true
 * value, and the column adds up exactly.
 */
function distributeRounding(values, decimals = 3) {
  const scale = 10 ** decimals;
  const clean = values.map(v => (Number.isFinite(v) ? v : null));
  const present = clean.filter(v => v != null);
  if (!present.length) return clean;

  // The headline is rounded from the true total, not from the rounded parts —
  // it is the number the parts must be made to agree with.
  const target = Math.round(present.reduce((a, b) => a + b, 0) * scale);

  const scaled = clean.map(v => (v == null ? null : v * scale));
  const floors = scaled.map(v => (v == null ? null : Math.floor(v)));
  const sumFloors = floors.reduce((a, b) => a + (b ?? 0), 0);

  // Each remainder is in [0,1), so `need` is between 0 and the number of
  // entries — one unit at most per entry, which is what bounds the distortion.
  let need = target - sumFloors;

  const order = clean
    .map((v, i) => ({ i, rem: v == null ? -1 : scaled[i] - floors[i] }))
    .filter(x => x.rem >= 0)
    .sort((a, b) => b.rem - a.rem);

  const out = floors.slice();
  // Hand a unit to the largest remainders first; if `need` is negative (the
  // total rounded down past the floors) take units from the smallest.
  for (let k = 0; need > 0 && k < order.length; k++, need--) out[order[k].i] += 1;
  for (let k = order.length - 1; need < 0 && k >= 0; k--, need++) out[order[k].i] -= 1;

  return out.map(v => (v == null ? null : v / scale));
}

/**
 * Contributions with a `display` value that is safe to render and to add up.
 * `display` is what the UI must show; `contribution` stays the true number.
 */
function displayContributions(monitor, decimals = 3) {
  const cs = monitor?.composite?.contributions || [];
  const rounded = distributeRounding(cs.map(c => c.contribution), decimals);
  return cs.map((c, i) => ({ ...c, display: rounded[i] }));
}

/** `in 2 days` / `today` / `tomorrow`, computed at render so it cannot go stale. */
function countdown(daysAway) {
  if (daysAway == null || !Number.isFinite(daysAway)) return null;
  if (daysAway <= 0) return 'today';
  if (daysAway === 1) return 'tomorrow';
  return `in ${daysAway} days`;
}

/**
 * The paragraph under the headline: why the composite reads the way it does.
 *
 * Built from the two largest contributions and whether they offset, because
 * "close to neutral" has two very different causes — everything quiet, or
 * strong forces cancelling — and the composite alone cannot tell them apart.
 */
function explain(monitor) {
  const c = monitor?.composite;
  if (!c || c.score == null) {
    return 'Not enough current data to read a regime. The indicator detail below shows what is available.';
  }
  const { pressure, offset } = signalTriad(monitor);
  const parts = [];

  if (pressure && offset) {
    const dominant = Math.abs(offset.value) > Math.abs(pressure.value) ? 'offset' : 'pressure';
    parts.push(
      `${cap(COMPONENT_PHRASE[pressure.key] || pressure.key)} is adding upward pressure, while ${COMPONENT_PHRASE[offset.key] || offset.key} is pulling the other way.`
    );
    const gap = Math.abs(Math.abs(offset.value) - Math.abs(pressure.value));
    if (gap < 0.05) {
      parts.push('The two are close to balanced, which is what holds the composite near the middle of its range.');
    } else if (dominant === 'offset') {
      parts.push(`The ${COMPONENT_PHRASE[offset.key] || 'offsetting'} side is currently the larger of the two, which is why the composite sits below zero.`);
    } else {
      parts.push(`The ${COMPONENT_PHRASE[pressure.key] || 'pressure'} side is currently the larger of the two, which is why the composite sits above zero.`);
    }
  } else if (pressure) {
    parts.push(`${cap(COMPONENT_PHRASE[pressure.key] || pressure.key)} is adding upward pressure, with nothing currently offsetting it.`);
  } else if (offset) {
    parts.push(`${cap(COMPONENT_PHRASE[offset.key] || offset.key)} is easing, with no component currently pushing the other way.`);
  }

  const conf = confidenceConstraint(monitor.confidence);
  if (conf?.key === 'agreement') {
    parts.push('The components disagree sharply, so a near-zero score here means offsetting forces rather than a settled picture.');
  }

  const next = monitor?.releases?.next;
  if (next) {
    parts.push(`${next.title} lands ${countdown(next.daysAway)} and is the next thing that could move this.`);
  }
  return parts.join(' ');
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * One sentence, for the reader who will not read four.
 *
 * The long version stays available behind "More detail" — this is the line
 * that has to carry the screen if nothing else is read.
 */
function explainShort(monitor) {
  const c = monitor?.composite;
  if (!c || c.score == null) return 'Not enough current data to read a regime.';
  const { pressure, offset } = signalTriad(monitor);
  const regime = c.regime === 'neutral' ? 'near neutral'
    : c.regime === 'cooling' ? 'on the cooling side'
      : 'on the re-accelerating side';

  if (pressure && offset) {
    return `${cap(COMPONENT_PHRASE[pressure.key] || pressure.key)} is still firm, while softer ${COMPONENT_PHRASE[offset.key] || offset.key} reduces the pressure it creates, keeping the policy signal ${regime}.`;
  }
  if (pressure) return `${cap(COMPONENT_PHRASE[pressure.key] || pressure.key)} is adding pressure with nothing offsetting it, putting the policy signal ${regime}.`;
  if (offset) return `${cap(COMPONENT_PHRASE[offset.key] || offset.key)} is easing with nothing pushing back, putting the policy signal ${regime}.`;
  return `The policy signal is ${regime}.`;
}

const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * When a monthly series' NEXT reference month is likely to publish.
 *
 * Derived from the catalogue's own release lag rather than hardcoded, so it
 * cannot drift: month M reaches the feed roughly `releaseLagDays` after the
 * month ends. Returns null when the lag is unknown — a made-up date is worse
 * than none, since a reader would plan around it.
 */
function nextPublishDate(latestDate, releaseLagDays) {
  if (!latestDate || !Number.isFinite(releaseLagDays)) return null;
  const d = new Date(`${String(latestDate).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(1);
  // First of the month AFTER the next unreported one, then the lag. Core PCE
  // has June, so the next reading is July, which closes on 1 Aug and publishes
  // ~30 days later. Subtracting 30 here (an earlier attempt) cancelled the lag
  // and produced "Aug 1", four weeks early.
  d.setUTCMonth(d.getUTCMonth() + 2);
  d.setUTCDate(d.getUTCDate() + releaseLagDays);
  return d.toISOString().slice(0, 10);
}

/**
 * A core inflation measure that has reported a MORE RECENT month than the one
 * being scored.
 *
 * This exists because of a real question: core CPI publishes about two weeks
 * before core PCE, so for roughly half of every month a fresher and materially
 * different inflation reading sits in the table while the bar reflects the
 * older one. On 2026-08-12 core CPI had July at 2.42% annualized and core PCE
 * still had June at 3.76%. Without saying so, the panel looks stale on exactly
 * the day a CPI print lands.
 *
 * The scored measure does NOT change. The two sit over a point apart, so
 * switching to whichever is freshest would swing the composite on measure
 * choice rather than on the economy.
 */
function fresherCoreMeasure(monitor, scoredSeriesId) {
  const inds = monitor?.indicators || [];
  const scored = inds.find(i => i.seriesId === scoredSeriesId);
  const other = inds.find(i => (i.seriesId === 'PCEPILFE' || i.seriesId === 'CPILFESL') && i.seriesId !== scoredSeriesId);
  if (!scored?.latestDate || !other?.latestDate) return null;
  if (!(other.latestDate > scored.latestDate)) return null;
  if (!Number.isFinite(other.annualized6m)) return null;
  return {
    seriesId: other.seriesId,
    label: other.seriesId === 'CPILFESL' ? 'Core CPI' : 'Core PCE',
    month: MONTH_NAME[+other.latestDate.slice(5, 7) - 1],
    annualized6m: other.annualized6m,
    momPct: other.momPct,
    yoyPct: other.yoyPct,
    scoredLabel: scoredSeriesId === 'PCEPILFE' ? 'core PCE' : 'core CPI',
    scoredNextPublish: nextPublishDate(scored.latestDate, scored.releaseLagDays),
  };
}

/**
 * Why one component contributes what it does, in a sentence.
 *
 * Derived from the same values that produced the score, so a bar can never
 * show a number the text does not account for.
 */
function componentInterpretation(key, monitor) {
  const s = monitor?.signals?.[key];
  const T = monitor?.thresholds;
  if (!s) return '';
  if (s.score == null) return s.reason ? cap(s.reason) : 'No current reading.';
  const dt = s.detail || {};

  switch (key) {
    case 'inflation': {
      const a6 = dt.annualized6m, a3 = dt.annualized3m;
      if (!Number.isFinite(a6)) return 'No current reading.';
      const level = a6 > (T?.inflation?.hot6m ?? 3.5) ? 'remains above the preferred range'
        : a6 < (T?.inflation?.cool6m ?? 2.0) ? 'is running below target' : 'is close to target';
      const mom = Number.isFinite(a3)
        ? (a3 < a6 ? ', though the three-month pace is slower' : a3 > a6 ? ', and the three-month pace is faster' : '')
        : '';
      const measure = s.used === 'CPILFESL' ? 'Core CPI' : 'Core PCE';
      let text = `${measure}, the measure this component scores, ${level} at ${n2(a6)}% annualized over six months${mom}.`;
      // The clause that answers "I saw a CPI print today, why has nothing
      // moved?" — see fresherCoreMeasure.
      const fresher = fresherCoreMeasure(monitor, s.used);
      if (fresher) {
        const when = fresher.scoredNextPublish
          ? `, whose ${fresher.month} reading publishes around ${MONTH_NAME[+fresher.scoredNextPublish.slice(5, 7) - 1].slice(0, 3)} ${+fresher.scoredNextPublish.slice(8, 10)}`
          : '';
        // Lead with the figures the release itself reported. "Reported July at
        // 2.42% annualized" reads as an official print and is not one — the
        // official July numbers are the MoM and YoY.
        const official = [
          Number.isFinite(fresher.momPct) ? `${n2(fresher.momPct)}% month-over-month` : null,
          Number.isFinite(fresher.yoyPct) ? `${n2(fresher.yoyPct)}% year-over-year` : null,
        ].filter(Boolean).join(' and ');
        text += official
          ? ` ${fresher.label} reported ${fresher.month} at ${official}, a ${n2(fresher.annualized6m)}% six-month annualized pace — not scored here, because the component tracks ${fresher.scoredLabel}${when}.`
          : ` ${fresher.label} has since reported ${fresher.month} at a ${n2(fresher.annualized6m)}% six-month annualized pace — not scored here, because the component tracks ${fresher.scoredLabel}${when}.`;
      }
      return text;
    }
    case 'labour': {
      const pay = dt.avg3mChangeThousands, un = dt.unemploymentChangePp;
      const parts = [];
      if (Number.isFinite(pay)) parts.push(`payroll momentum is averaging ${fmtK(pay)} a month`);
      if (Number.isFinite(un)) parts.push(`unemployment has ${un > 0 ? 'edged higher' : un < 0 ? 'edged lower' : 'held flat'} by ${n2(Math.abs(un))}pp over six months`);
      return parts.length ? `${cap(parts.join(' while '))}.` : 'No current reading.';
    }
    case 'wages': {
      const v = dt.yoyPct;
      if (!Number.isFinite(v)) return 'No current reading.';
      const cool = T?.wages?.yoyCool ?? 3.5;
      return v < cool
        ? `Wage growth at ${n2(v)}% year-over-year is below the ${n2(cool)}% pace considered consistent with target.`
        : `Wage growth at ${n2(v)}% year-over-year is at or above the ${n2(cool)}% pace considered consistent with target.`;
    }
    case 'expectations': {
      const v = dt.latest, ch = dt.changePp;
      if (!Number.isFinite(v)) return 'No current reading.';
      const anchored = v > (T?.expectations?.levelHot ?? 2.6) ? 'drifting above the anchored range' : 'within the anchored range';
      const drift = Number.isFinite(ch) ? `, ${ch > 0 ? 'up' : ch < 0 ? 'down' : 'unchanged'} ${n2(Math.abs(ch))}pp over six months` : '';
      return `Long-run market expectations are ${anchored} at ${n2(v)}%${drift}.`;
    }
    case 'oil': {
      const v = dt.roc6mPct;
      if (!Number.isFinite(v)) return 'No current reading.';
      return v > (T?.oil?.rocHot ?? 25)
        ? `Oil is up ${n2(v)}% over six months, creating upside headline-inflation risk.`
        : v < (T?.oil?.rocCool ?? -15)
          ? `Oil is down ${n2(Math.abs(v))}% over six months, easing headline inflation.`
          : `Oil is ${signed(v)}% over six months, roughly range-bound.`;
    }
    default: return '';
  }
}

/** "CPI (Inflation) Report" → "CPI Report". Parentheticals add width, not meaning. */
function shortTitle(title) {
  if (!title) return null;
  return String(title).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The reference month a release covers, pulled from the calendar's own detail
 * text. Returns null rather than guessing — a release covering the wrong month
 * is worse than one that does not say.
 */
function reportMonth(detail) {
  if (!detail) return null;
  const m = String(detail).match(/(?:Report|Estimate|Data)\s+for\s+([A-Z][a-z]+\s+\d{4}|Q[1-4]\s+\d{4})/);
  return m ? m[1] : null;
}

// Shown on the score, because a small negative number invites exactly the
// wrong reading — that it is a probability.
const SCORE_TOOLTIP =
  'The macro score summarises the weighted contributions of inflation, labour, wages, expectations and oil over the current six-month window. '
  + 'It is not a probability and not a forecast of the Federal Reserve\'s decision.';

/**
 * What would move the reading, computed against the thresholds that produced it.
 *
 * Only for components that are actually scoring, and phrased as conditions on
 * observable data — never as a claim about what any central bank would then do.
 */
/**
 * Every scored lever, with the two markers that would move it.
 *
 * `higherIsHotter: false` for unemployment, which cools as it RISES — the one
 * inverted series, and the easiest thing here to get backwards.
 */
function levers(monitor) {
  const T = monitor?.thresholds;
  const s = monitor?.signals;
  if (!T || !s) return [];
  const L = [
    { key: 'inflation', weight: T.weights?.inflation ?? 0.45, noun: 'Core inflation',
      value: s.inflation?.detail?.annualized6m, fmt: (v) => `${n2(v)}%`, unit: 'annualized over six months',
      coolAt: T.inflation?.cool6m, hotAt: T.inflation?.hot6m, higherIsHotter: true },
    { key: 'labour', weight: T.weights?.labour ?? 0.25, noun: 'Hiring',
      value: s.labour?.detail?.avg3mChangeThousands, fmt: (v) => fmtK(v), unit: 'a month over three months',
      coolAt: T.labour?.payrollsCool, hotAt: T.labour?.payrollsHot, higherIsHotter: true },
    { key: 'unemployment', weight: (T.weights?.labour ?? 0.25) * (T.labour?.unemploymentWeight ?? 0.4), noun: 'The unemployment rate',
      value: s.labour?.detail?.unemploymentChangePp, fmt: (v) => `${signed(v)}pp`, unit: 'over six months',
      coolAt: T.labour?.unemploymentCoolPp, hotAt: T.labour?.unemploymentHotPp, higherIsHotter: false },
    { key: 'wages', weight: T.weights?.wages ?? 0.15, noun: 'Wage growth',
      value: s.wages?.detail?.yoyPct, fmt: (v) => `${n2(v)}%`, unit: 'year-over-year',
      coolAt: T.wages?.yoyCool, hotAt: T.wages?.yoyHot, higherIsHotter: true },
    { key: 'expectations', weight: T.weights?.expectations ?? 0.10, noun: 'Long-run inflation expectations',
      value: s.expectations?.detail?.latest, fmt: (v) => `${n2(v)}%`, unit: '',
      coolAt: T.expectations?.levelCool, hotAt: T.expectations?.levelHot, higherIsHotter: true },
    { key: 'oil', weight: T.weights?.oil ?? 0.05, noun: 'Oil',
      value: s.oil?.detail?.roc6mPct, fmt: (v) => `${signed(v)}%`, unit: 'over six months',
      coolAt: T.oil?.rocCool, hotAt: T.oil?.rocHot, higherIsHotter: true },
  ];
  return L.filter(l => Number.isFinite(l.value) && Number.isFinite(l.coolAt) && Number.isFinite(l.hotAt));
}

/**
 * What would move the reading, split by which way it would move it.
 *
 * Grouped rather than listed because "what would change this" is really two
 * questions with opposite answers, and a flat list makes the reader work out
 * which direction each condition points. Ordered by weight, capped at two per
 * group: the levers that cannot move the composite much are noise here.
 *
 * Phrased as conditions on observable data. Never as a claim about what any
 * central bank would then do — the group headings say "signal", not "decision".
 */
function whatWouldChangeByDirection(monitor) {
  const all = levers(monitor).sort((a, b) => b.weight - a.weight);
  const hotter = [];
  const cooler = [];

  for (const l of all) {
    // A lever already past its marker cannot "rise above" it, and dropping it
    // for that reason is how the heaviest component vanished from the list —
    // core inflation at 3.76% against a 3.50% marker was simply absent. Beyond
    // the marker, the condition is that it STAYS there rather than reverting.
    const beyondHot = l.higherIsHotter ? l.value >= l.hotAt : l.value <= l.hotAt;
    const beyondCool = l.higherIsHotter ? l.value <= l.coolAt : l.value >= l.coolAt;

    // Say which SIDE explicitly. "Beyond" reads as "above" whichever way the
    // series runs, and that is wrong half the time — hiring at +20k against a
    // +50k marker is below it, not beyond it.
    const towardHot = beyondHot
      ? `holding ${l.higherIsHotter ? 'above' : 'below'} ${l.fmt(l.hotAt)} rather than reverting`
      : `${l.higherIsHotter ? 'rising above' : 'falling below'} ${l.fmt(l.hotAt)}`;
    const towardCool = beyondCool
      ? `holding ${l.higherIsHotter ? 'below' : 'above'} ${l.fmt(l.coolAt)} rather than reverting`
      : `${l.higherIsHotter ? 'falling below' : 'rising above'} ${l.fmt(l.coolAt)}`;

    const at = `now ${l.fmt(l.value)}${l.unit ? ` ${l.unit}` : ''}`;
    // Every lever appears in BOTH lists — it can always move either way, and
    // its marker in each direction is exactly what the reader is asking for.
    if (hotter.length < 2) hotter.push(`${l.noun} ${towardHot} — ${at}.`);
    if (cooler.length < 2) cooler.push(`${l.noun} ${towardCool} — ${at}.`);
  }

  const regime = monitor?.composite?.regime;
  const groups = [];
  if (hotter.length) {
    groups.push({
      direction: 'hotter',
      heading: 'Would push toward hike-risk',
      items: hotter,
    });
  }
  if (cooler.length) {
    groups.push({
      direction: 'cooler',
      heading: 'Would push toward a cut-compatible signal',
      items: cooler,
    });
  }
  if (regime === 'neutral' && hotter.length && cooler.length) {
    groups.push({
      direction: 'hold',
      heading: 'Would reinforce the current hold-compatible reading',
      items: ['Both sides staying inside their current ranges, leaving the components offsetting one another as they do now.'],
    });
  }
  return groups;
}

function whatWouldChange(monitor) {
  const T = monitor?.thresholds;
  const out = [];
  if (!T) return out;

  const infl = monitor.signals?.inflation;
  const a6 = infl?.detail?.annualized6m;
  if (Number.isFinite(a6)) {
    if (a6 > T.inflation.hot6m) {
      out.push(`Core inflation is running at ${n2(a6)}% on a 6-month annualized basis, above the ${n2(T.inflation.hot6m)}% upper marker. Falling back under ${n2(T.inflation.hot6m)}% would ease the largest single source of pressure; under ${n2(T.inflation.cool6m)}% would remove it.`);
    } else if (a6 < T.inflation.cool6m) {
      out.push(`Core inflation at ${n2(a6)}% is below the ${n2(T.inflation.cool6m)}% marker. A sustained move back above ${n2(T.inflation.hot6m)}% would restore it as a source of pressure.`);
    } else {
      out.push(`Core inflation at ${n2(a6)}% sits between the ${n2(T.inflation.cool6m)}% and ${n2(T.inflation.hot6m)}% markers. Crossing either would move the heaviest component decisively.`);
    }
  }

  const lab = monitor.signals?.labour?.detail;
  if (Number.isFinite(lab?.avg3mChangeThousands)) {
    out.push(`Hiring is averaging ${fmtK(lab.avg3mChangeThousands)} a month against a ${T.labour.payrollsCool}k cooling marker and ${T.labour.payrollsHot}k tightening marker. A run back above ${T.labour.payrollsHot}k, or a further slide with unemployment rising, would move the labour component to the opposite side.`);
  }

  const wag = monitor.signals?.wages?.detail;
  if (Number.isFinite(wag?.yoyPct)) {
    out.push(`Wage growth at ${n2(wag.yoyPct)}% year-over-year is below the ${n2(T.wages.yoyCool)}% pace considered consistent with target. Back above ${n2(T.wages.yoyHot)}% would turn the current largest offset into a source of pressure.`);
  }

  const exp = monitor.signals?.expectations?.detail;
  if (Number.isFinite(exp?.latest)) {
    out.push(`Long-run inflation expectations are ${n2(exp.latest)}%. A move above ${n2(T.expectations.levelHot)}% would mark them as drifting rather than anchored.`);
  }
  return out;
}

const fmtK = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)}k`);

/**
 * Freshness as a status word rather than a raw date.
 *
 * "Context only" wins over everything: an unscored series being a release
 * behind is not a problem to act on, and flagging it as one is what led a
 * reviewer to conclude a stale survey print was moving the score.
 */
function freshnessStatus(indicator, maxForScoring = 1) {
  if (!indicator) return { label: 'Unknown', tone: 'muted' };
  if (indicator.scored === false) return { label: 'Context only', tone: 'muted' };
  const behind = indicator.releasesBehind;
  if (behind == null) return { label: 'Fresh', tone: 'ok' };
  if (behind === 0) return { label: 'Fresh', tone: 'ok' };
  if (behind <= maxForScoring) return { label: 'One release behind', tone: 'warn' };
  return { label: 'Stale', tone: 'bad' };
}

/** The six-month headline, always naming which calculation produced it. */
function sixMonthRead(ind) {
  if (!ind) return { value: '—', label: '' };
  if (ind.transform === 'index' && Number.isFinite(ind.annualized6m)) {
    return { value: `${signed(ind.annualized6m)}%`, label: '6m annualized' };
  }
  if (ind.transform === 'rate' && Number.isFinite(ind.changePp)) {
    return { value: `${signed(ind.changePp)}pp`, label: '6m change' };
  }
  if (ind.transform === 'price' && Number.isFinite(ind.rocPct)) {
    return { value: `${signed(ind.rocPct)}%`, label: '6m percent change' };
  }
  if (ind.transform === 'count' && Number.isFinite(ind.avg3mChange)) {
    return { value: fmtK(ind.avg3mChange), label: '3m average per month' };
  }
  return { value: '—', label: 'no six-month reading' };
}

const signed = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);

/** One-line reading of an indicator, in the panel's vocabulary. */
function interpretIndicator(ind, thresholds) {
  if (!ind) return '';
  const T = thresholds || {};
  switch (ind.key) {
    case 'corePce':
    case 'coreCpi': {
      const v = ind.annualized6m;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > (T.inflation?.hot6m ?? 3.5)) return 'Above target — still firm';
      if (v < (T.inflation?.cool6m ?? 2.0)) return 'Below target — disinflationary';
      return 'Near target — no longer adding pressure';
    }
    case 'payrolls': {
      const v = ind.avg3mChange;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v < (T.labour?.payrollsCool ?? 50)) return 'Hiring moderating — labour cooling';
      if (v > (T.labour?.payrollsHot ?? 200)) return 'Hiring strong — labour tightening';
      return 'Hiring steady — neither adding nor easing pressure';
    }
    case 'unemployment': {
      const v = ind.changePp;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > 0.1) return 'Unemployment rising — more slack';
      if (v < -0.1) return 'Unemployment falling — less slack than before';
      return 'Unemployment flat — slack unchanged';
    }
    case 'wages': {
      // Scored on year-over-year, but the six-month column shows the annualized
      // pace — two different numbers for the same series. Naming the basis stops
      // a reader matching the verdict to the figure beside it.
      const v = ind.yoyPct;
      if (!Number.isFinite(v)) return 'No current reading';
      const basis = ` (${v.toFixed(2)}% YoY, the scored basis)`;
      if (v > (T.wages?.yoyHot ?? 4.5)) return `Above target-consistent pace${basis}`;
      if (v < (T.wages?.yoyCool ?? 3.5)) return `Consistent with target${basis}`;
      return `Slightly above target-consistent pace${basis}`;
    }
    case 'oil': {
      const v = ind.rocPct;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > (T.oil?.rocHot ?? 25)) return 'Rising sharply — upside risk';
      if (v < (T.oil?.rocCool ?? -15)) return 'Falling — disinflationary';
      return 'Range-bound';
    }
    case 'expectations': {
      const v = ind.latest;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > (T.expectations?.levelHot ?? 2.6)) return 'Drifting above anchor — expectations slipping';
      if (v < (T.expectations?.levelCool ?? 2.15)) return 'Well anchored — expectations not drifting';
      return 'Anchored — expectations not drifting';
    }
    case 'expectationsSurvey': return 'Households above market-implied';
    case 'headlineCpi': return 'Includes food and energy';
    default: return '';
  }
}

/** Why an unscored series is unscored — always answerable, never blank. */
function contextReason(ind) {
  if (!ind || ind.scored !== false) return null;
  if (ind.key === 'expectationsSurvey') {
    return ind.releasesBehind > 0
      ? 'Survey-based and one release behind. Carried for contrast with the market-implied measure, never scored.'
      : 'Survey-based. Carried for contrast with the market-implied measure, never scored.';
  }
  if (ind.key === 'headlineCpi') return 'Core measures drive the score; counting headline too would double-count energy alongside the oil component.';
  return 'Carried for context, not scored.';
}

export {
  REGIME_WORD, POLICY_WORD, COMPONENT_LABEL, COMPONENT_PHRASE, SCORE_TOOLTIP,
  directionWord, confidenceConstraint, signalTriad, countdown,
  distributeRounding, displayContributions,
  explain, explainShort, componentInterpretation, whatWouldChange,
  fresherCoreMeasure, nextPublishDate,
  whatWouldChangeByDirection, levers,
  freshnessStatus, sixMonthRead, interpretIndicator, contextReason,
  shortTitle, reportMonth, signed, fmtK,
};
