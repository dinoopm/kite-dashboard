// ─── Risk-On / Risk-Off regime ───────────────────────────────────────────────
// "Is money flowing into bonds (safety) or stocks (risk)?" read from three
// deterministic gauges over the last ~1 month of daily closes (Yahoo):
//   1. US 10Y yield direction (^TNX) — rising = money LEAVING bonds (risk-on);
//      falling = money INTO bonds (risk-off).
//   2. Stocks vs long Treasuries (SPY − TLT) — equities winning = risk-on.
//   3. Junk vs investment-grade credit (HYG − LQD) — junk winning = appetite
//      (risk-on); investment-grade winning = flight to quality (risk-off).
// Each gauge scores -1 / 0 / +1; the sum maps to RISK-ON / NEUTRAL / RISK-OFF.
// No forecasting — just what the money has actually been doing.
//
// History. The panel used to show only today's word, so "it was risk-off
// before" could not be answered from the app. It now carries two kinds:
//   · a strip of the last 60 sessions REPLAYED from stored daily closes by
//     regimeHistory() — faithful (the same rules over the same closes) but
//     assembled after the fact, so it is labelled reconstructed;
//   · verdict TRANSITIONS RECORDED to signal_emissions by dailyJobs, after
//     each US close, before anything that follows exists. Only those rows can
//     ever serve as evidence (registry: risk_regime, blocked).
// Both read the thresholds from RULES, so the strip, the live word and the
// record cannot drift into describing different rules.

const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { cnbcUs10y } = require('./cnbcQuote');
const { ruleFingerprint } = require('./signals/audit');

const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));
const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));

/** Daily closes with their session dates (ET; Yahoo stamps US bars at the open). */
async function dailyCloses(symbol, period1) {
  const c = await yf.chart(symbol, { period1, interval: '1d' }, { validateResult: false });
  return c.quotes.filter(q => q.close != null).map(q => ({ date: q.date.toISOString().slice(0, 10), close: q.close }));
}
const ret = (a, days) => (a.length > days ? (a[a.length - 1] / a[a.length - 1 - days] - 1) * 100 : null);
const chg = (a, days) => (a.length > days ? a[a.length - 1] - a[a.length - 1 - days] : null);

// ~5 months back gives room for the 63-session (3mo) lookbacks, and for 60
// replayed sessions each needing 21 before it.
const START = () => { const d = new Date(); d.setMonth(d.getMonth() - 5); return d.toISOString().slice(0, 10); };
const Q = 63; // ≈ 3 months (context)
const HISTORY_SESSIONS = 60;

const RULES = Object.freeze({
  windowSessions: 21,     // trading days ≈ 1 month (primary signal window)
  yieldBandPp: 0.08,      // 1mo 10Y change inside ±this is "flat"
  stocksBondsBandPp: 2,   // SPY − TLT 1mo return gap inside ±this is "tied"
  creditBandPp: 0.5,      // HYG − LQD 1mo return gap inside ±this is "tied"
  verdictAt: 2,           // |sum of gauge scores| needed for RISK-ON / RISK-OFF
});
const M = RULES.windowSessions;

const band = (v, b) => (v > b ? 1 : v < -b ? -1 : 0);

/** The rule itself: three one-month readings → three scores and a label. Pure. */
function scoreRegime({ yield1mo, spyTlt1mo, hygLqd1mo }, rules = RULES) {
  const scores = {
    yield: band(yield1mo, rules.yieldBandPp),
    stocksBonds: band(spyTlt1mo, rules.stocksBondsBandPp),
    credit: band(hygLqd1mo, rules.creditBandPp),
  };
  const score = scores.yield + scores.stocksBonds + scores.credit; // −3…+3
  const label = score >= rules.verdictAt ? 'RISK-ON' : score <= -rules.verdictAt ? 'RISK-OFF' : 'NEUTRAL';
  return { scores, score, label };
}

// Changes when the thresholds or the scoring logic change — not when a comment
// in this file does, which would split one rule's record into several.
const RULE_VERSION = ruleFingerprint('risk-regime', [JSON.stringify(RULES), scoreRegime.toString(), band.toString()]);

const VERDICT_TEXT = {
  'RISK-ON': { tone: 'good', text: 'Money is favouring stocks over bonds — no flight to safety.' },
  'RISK-OFF': { tone: 'alert', text: 'Money is rotating into bonds — a defensive, flight-to-safety tilt.' },
  NEUTRAL: { tone: 'neutral', text: 'No decisive rotation between stocks and bonds right now.' },
};

const etParts = (now) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
};

/**
 * Has this US session closed? Yahoo serves today's bar while it is still
 * trading, and a replay that included it would put a moving number in a strip
 * of settled ones. 16:15 ET leaves the closing auction time to print.
 */
function sessionComplete(date, now = new Date()) {
  const et = etParts(now);
  if (date < et.date) return true;
  if (date > et.date) return false;
  return et.minutes >= 16 * 60 + 15;
}

/**
 * Replay the rule for each of the last `sessions` completed sessions. Pure.
 *
 * Dates are the intersection of all five series, so a bond-market holiday
 * (Columbus Day, Veterans Day — stocks open, ^TNX not) drops out rather than
 * pairing one symbol's close with another's from a different day. The live
 * read counts its 21 sessions per symbol instead; around such a holiday the
 * two can differ by a session, which is why the strip is labelled replayed.
 */
function regimeHistory(series, { sessions = HISTORY_SESSIONS, now = new Date(), rules = RULES } = {}) {
  const maps = Object.fromEntries(Object.entries(series).map(([k, rows]) => [k, new Map(rows.map(r => [r.date, r.close]))]));
  const keys = ['tnx', 'spy', 'tlt', 'hyg', 'lqd'];
  const dates = [...maps.spy.keys()]
    .filter(d => keys.every(k => maps[k].has(d)) && sessionComplete(d, now))
    .sort();
  const w = rules.windowSessions;
  const out = [];
  for (let i = w; i < dates.length; i++) {
    const at = (k) => maps[k].get(dates[i]);
    const then = (k) => maps[k].get(dates[i - w]);
    const pct = (k) => (at(k) / then(k) - 1) * 100;
    const inputs = { yield1mo: at('tnx') - then('tnx'), spyTlt1mo: pct('spy') - pct('tlt'), hygLqd1mo: pct('hyg') - pct('lqd') };
    const { label, score, scores } = scoreRegime(inputs, rules);
    out.push({
      date: dates[i], label, score, scores,
      yield: r2(at('tnx')), yield1mo: r2(inputs.yield1mo), spyTlt1mo: r1(inputs.spyTlt1mo), hygLqd1mo: r1(inputs.hygLqd1mo),
    });
  }
  return out.slice(-sessions);
}

/** Consecutive same-label stretches, oldest first. Pure. */
function regimeRuns(history) {
  const runs = [];
  for (const h of history) {
    const last = runs[runs.length - 1];
    if (last && last.label === h.label) { last.to = h.date; last.sessions++; }
    else runs.push({ label: h.label, from: h.date, to: h.date, sessions: 1 });
  }
  return runs;
}

/**
 * "NEUTRAL since 13 Nov, after RISK-OFF 22 Oct – 12 Nov." `since` is null when
 * today's live word differs from the last completed session's — it changed
 * today, and no settled session carries it yet.
 */
function sinceFor(history, currentLabel) {
  const runs = regimeRuns(history);
  const last = runs[runs.length - 1] || null;
  if (last && last.label === currentLabel) {
    // A run that fills the whole strip started at least that long ago; say so
    // rather than report the strip's first date as the start.
    const atLeast = runs.length === 1;
    return { label: currentLabel, since: last.from, sessions: last.sessions, atLeast, previous: runs[runs.length - 2] || null };
  }
  return { label: currentLabel, since: null, sessions: 0, atLeast: false, previous: last };
}

// India tie-in. This used to say a 10Y "~4.75%+ historically triggers FII
// selling of Indian equities" — a hard-coded threshold with no source and no
// check, i.e. a claim about future flows of exactly the kind CLAUDE.md says
// not to ship unvalidated. Checked on 2026-11-14 against this app's own
// fii_dii_activity (140 sessions, 2026-04-23 → 11-13, 10Y between 4.29% and
// 5.31%), with the 10Y taken at the prior US close: FIIs were net sellers on
// 60% of sessions with the 10Y at or above 4.75% (mean −197 cr) and on 66%
// below it (mean −1,602 cr). November, with the 10Y near 4.9%, was heavy net
// buying. That is one stretch of one regime, so it doesn't disprove a link,
// but nothing here supports a trigger level either. The note now states the
// mechanism without a threshold.
function indiaNoteFor(yieldNow) {
  return `US 10Y at ${r2(yieldNow)}%. Higher US yields make Indian equities less attractive to foreign investors, `
    + 'but no particular level reliably triggers FII selling — flows also turn on the rupee, valuations and global risk appetite.';
}

/** The registry's verdict on this rule, shaped for <SignalScore entry=…>. */
function validationEntry() {
  const meta = require('./signals/registry').signalMeta('risk_regime');
  return {
    signal: 'risk_regime', ruleVersion: RULE_VERSION, source: 'recorded',
    headline: { state: 'unscoreable', text: 'Unvalidated', detail: meta?.blockedReason || 'Not in the signal registry.' },
    description: meta?.description || null, horizons: [],
  };
}

async function riskRegime({ now = new Date() } = {}) {
  const start = START();
  const [tnxR, tltR, spyR, hygR, lqdR] = await Promise.all(
    ['^TNX', 'TLT', 'SPY', 'HYG', 'LQD'].map(s => dailyCloses(s, start))
  );
  const [tnx, tlt, spy, hyg, lqd] = [tnxR, tltR, spyR, hygR, lqdR].map(rows => rows.map(r => r.close));

  // The displayed 10Y level uses CNBC's live value (Yahoo ^TNX lags a session,
  // which made this panel disagree with the Treasury chart). The Yahoo series
  // is still used for the 1mo/3mo trend, with the live value as the current
  // endpoint so the change reflects today. Falls back to Yahoo if CNBC is down.
  let live = null;
  try { live = await cnbcUs10y(); } catch { /* fall back to Yahoo close */ }
  const yieldNow = live?.last ?? tnx[tnx.length - 1];
  const yield1mo = tnx.length > M ? yieldNow - tnx[tnx.length - 1 - M] : chg(tnx, M);
  const yield3mo = tnx.length > Q ? yieldNow - tnx[tnx.length - 1 - Q] : chg(tnx, Q);
  const spyTlt1mo = (ret(spy, M) ?? 0) - (ret(tlt, M) ?? 0);
  const hygLqd1mo = (ret(hyg, M) ?? 0) - (ret(lqd, M) ?? 0);

  const { scores, score, label } = scoreRegime({ yield1mo, spyTlt1mo, hygLqd1mo });
  const gauges = [
    {
      id: 'yield',
      label: 'US 10Y Treasury yield',
      value: `${r2(yieldNow)}%`,
      raw: r2(yield1mo),
      score: scores.yield,
      detail: scores.yield > 0 ? `rising (+${r2(yield1mo)}pp in a month) — money leaving bonds`
        : scores.yield < 0 ? `falling (${r2(yield1mo)}pp in a month) — money moving into bonds`
        : `flat (${yield1mo >= 0 ? '+' : ''}${r2(yield1mo)}pp) — no clear bond bid`,
    },
    {
      id: 'stocks-vs-bonds',
      label: 'Stocks vs long Treasuries (1mo)',
      value: `${spyTlt1mo >= 0 ? '+' : ''}${r1(spyTlt1mo)}pp`,
      raw: r1(spyTlt1mo),
      score: scores.stocksBonds,
      detail: scores.stocksBonds > 0 ? `S&P beating Treasuries by ${r1(spyTlt1mo)}pp — money in risk`
        : scores.stocksBonds < 0 ? `Treasuries beating the S&P by ${r1(-spyTlt1mo)}pp — money in safety`
        : `S&P and Treasuries roughly tied — no rotation`,
    },
    {
      id: 'credit',
      label: 'Junk vs investment-grade credit (1mo)',
      value: `${hygLqd1mo >= 0 ? '+' : ''}${r1(hygLqd1mo)}pp`,
      raw: r1(hygLqd1mo),
      score: scores.credit,
      detail: scores.credit > 0 ? `junk bonds winning — risk appetite is on`
        : scores.credit < 0 ? `safe bonds winning — flight to quality`
        : `junk and safe credit roughly tied`,
    },
  ];

  const verdict = { label, ...VERDICT_TEXT[label] };
  const history = regimeHistory({ tnx: tnxR, spy: spyR, tlt: tltR, hyg: hygR, lqd: lqdR }, { now });
  const sessionDate = spyR.length ? spyR[spyR.length - 1].date : null;

  return {
    verdict, score, gauges,
    yield: { now: r2(yieldNow), chg1mo: r2(yield1mo), chg3mo: r2(yield3mo) },
    context: { spy3mo: r1(ret(spy, Q)), tlt3mo: r1(ret(tlt, Q)) },
    indiaNote: indiaNoteFor(yieldNow),
    history, since: sinceFor(history, label),
    // What the recorder needs to decide whether this read is a settled one.
    sessionDate, sessionComplete: sessionDate ? sessionComplete(sessionDate, now) : false,
    rules: RULES, ruleVersion: RULE_VERSION, validation: validationEntry(),
    asOf: now.toISOString(),
    source: `${live ? 'CNBC live 10Y' : 'Yahoo ^TNX'} + Yahoo daily closes — TLT, SPY, HYG, LQD`,
  };
}

module.exports = { riskRegime, indiaNoteFor, scoreRegime, regimeHistory, regimeRuns, sinceFor, sessionComplete, RULES, RULE_VERSION };
