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

const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { cnbcUs10y } = require('./cnbcQuote');

const r1 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(1));
const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));

async function closes(symbol, period1) {
  const c = await yf.chart(symbol, { period1, interval: '1d' }, { validateResult: false });
  return c.quotes.filter(q => q.close != null).map(q => q.close);
}
const ret = (a, days) => (a.length > days ? (a[a.length - 1] / a[a.length - 1 - days] - 1) * 100 : null);
const chg = (a, days) => (a.length > days ? a[a.length - 1] - a[a.length - 1 - days] : null);

// ~5 months back gives room for the 63-session (3mo) lookbacks.
const START = () => { const d = new Date(); d.setMonth(d.getMonth() - 5); return d.toISOString().slice(0, 10); };
const M = 21; // trading days ≈ 1 month (primary signal window)
const Q = 63; // ≈ 3 months (context)

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

async function riskRegime() {
  const start = START();
  const [tnx, tlt, spy, hyg, lqd] = await Promise.all(
    ['^TNX', 'TLT', 'SPY', 'HYG', 'LQD'].map(s => closes(s, start))
  );

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

  const gauges = [
    {
      id: 'yield',
      label: 'US 10Y Treasury yield',
      value: `${r2(yieldNow)}%`,
      score: yield1mo > 0.08 ? 1 : yield1mo < -0.08 ? -1 : 0,
      detail: yield1mo > 0.08 ? `rising (+${r2(yield1mo)}pp in a month) — money leaving bonds`
        : yield1mo < -0.08 ? `falling (${r2(yield1mo)}pp in a month) — money moving into bonds`
        : `flat (${yield1mo >= 0 ? '+' : ''}${r2(yield1mo)}pp) — no clear bond bid`,
    },
    {
      id: 'stocks-vs-bonds',
      label: 'Stocks vs long Treasuries (1mo)',
      value: `${spyTlt1mo >= 0 ? '+' : ''}${r1(spyTlt1mo)}pp`,
      score: spyTlt1mo > 2 ? 1 : spyTlt1mo < -2 ? -1 : 0,
      detail: spyTlt1mo > 2 ? `S&P beating Treasuries by ${r1(spyTlt1mo)}pp — money in risk`
        : spyTlt1mo < -2 ? `Treasuries beating the S&P by ${r1(-spyTlt1mo)}pp — money in safety`
        : `S&P and Treasuries roughly tied — no rotation`,
    },
    {
      id: 'credit',
      label: 'Junk vs investment-grade credit (1mo)',
      value: `${hygLqd1mo >= 0 ? '+' : ''}${r1(hygLqd1mo)}pp`,
      score: hygLqd1mo > 0.5 ? 1 : hygLqd1mo < -0.5 ? -1 : 0,
      detail: hygLqd1mo > 0.5 ? `junk bonds winning — risk appetite is on`
        : hygLqd1mo < -0.5 ? `safe bonds winning — flight to quality`
        : `junk and safe credit roughly tied`,
    },
  ];

  const score = gauges.reduce((s, g) => s + g.score, 0); // −3…+3
  const verdict = score >= 2
    ? { label: 'RISK-ON', tone: 'good', text: 'Money is favouring stocks over bonds — no flight to safety.' }
    : score <= -2
      ? { label: 'RISK-OFF', tone: 'alert', text: 'Money is rotating into bonds — a defensive, flight-to-safety tilt.' }
      : { label: 'NEUTRAL', tone: 'neutral', text: 'No decisive rotation between stocks and bonds right now.' };

  const y = yieldNow;
  const indiaNote = indiaNoteFor(y);

  return {
    verdict, score, gauges,
    yield: { now: r2(y), chg1mo: r2(yield1mo), chg3mo: r2(yield3mo) },
    context: { spy3mo: r1(ret(spy, Q)), tlt3mo: r1(ret(tlt, Q)) },
    indiaNote,
    asOf: new Date().toISOString(),
    source: `${live ? 'CNBC live 10Y' : 'Yahoo ^TNX'} + Yahoo daily closes — TLT, SPY, HYG, LQD`,
  };
}

module.exports = { riskRegime, indiaNoteFor };
