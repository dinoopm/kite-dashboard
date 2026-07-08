// ─── Macro event-reaction study ──────────────────────────────────────────────
// Base rates for "what actually happens around US macro events": for every
// past FOMC decision day (scraped from the Fed's official calendar, 2021→)
// plus any past events accumulated in macro_events (CPI/jobs/GDP grow over
// time — historical BLS schedules aren't scrapeable), measure:
//   · S&P 500 same-day return (^GSPC)
//   · US 10Y yield same-day change in bps (^TNX, quoted in percent)
//   · NIFTY 50 NEXT-session return (^NSEI) — CPI lands 6PM IST and the FOMC
//     11:30PM IST, both after India's close, so India reacts a session later
//   · FII net flow on that next session (fii_dii_activity; short history, so
//     its n is reported separately)
// against an all-days baseline over the same window, so "±0.8% on FOMC days"
// means something. Deterministic arithmetic; no forecasting.

const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MONTH_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const r2 = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Decision days (Day 2) of past FOMC meetings from federalreserve.gov.
// Formats seen: "January | 27-28", "March | 17-18*", cross-month
// "Apr/May | 30-1" (decision day = May 1). Year comes from the panel heading.
async function pastFomcDecisionDates() {
  const r = await axios.get('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { headers: { 'User-Agent': UA }, timeout: 20000 });
  const html = r.data.replace(/\s+/g, ' ');
  const sections = html.split(/(\d{4}) FOMC Meetings/).slice(1); // [year, chunk, year, chunk, ...]
  const dates = [];
  for (let i = 0; i < sections.length; i += 2) {
    const year = Number(sections[i]);
    const chunk = sections[i + 1] || '';
    for (const m of chunk.matchAll(/fomc-meeting__month[^>]*><strong>([^<]+)<\/strong><\/div>\s*<div class="fomc-meeting__date[^>]*>([^<]+)</g)) {
      const monthTxt = m[1].trim(), dayTxt = m[2].trim();
      const dm = dayTxt.match(/(\d{1,2})-(\d{1,2})/);
      if (!dm) continue; // one-day/unscheduled rows — skip
      const months = monthTxt.split('/').map(x => MONTH_NUM[x.trim().toLowerCase()]).filter(Boolean);
      const endMonth = months[months.length - 1];
      if (!endMonth) continue;
      dates.push(`${year}-${String(endMonth).padStart(2, '0')}-${String(Number(dm[2])).padStart(2, '0')}`);
    }
  }
  return [...new Set(dates)].sort();
}

async function chartCloses(symbol, period1) {
  const c = await yf.chart(symbol, { period1, interval: '1d' });
  const out = [];
  for (const q of c.quotes) {
    if (q.close == null) continue;
    out.push({ date: q.date.toISOString().slice(0, 10), close: q.close });
  }
  return out;
}

// Series wrapper: exact-date lookup + prev/next trading-session navigation.
function makeSeries(rows) {
  const idx = new Map(rows.map((r, i) => [r.date, i]));
  return {
    rows,
    // return% on the exact date D vs the previous session; null if D wasn't a session
    retOn(d) {
      const i = idx.get(d);
      if (i == null || i === 0) return null;
      return (rows[i].close / rows[i - 1].close - 1) * 100;
    },
    deltaOn(d) {
      const i = idx.get(d);
      if (i == null || i === 0) return null;
      return rows[i].close - rows[i - 1].close;
    },
    // first session strictly after D: its date and return
    nextSession(d) {
      let i = idx.get(d);
      if (i == null) { i = rows.findIndex(r => r.date > d) - 1; if (i < 0) return null; }
      if (i + 1 >= rows.length) return null;
      return { date: rows[i + 1].date, ret: (rows[i + 1].close / rows[i].close - 1) * 100 };
    },
    avgAbsRet() {
      const rets = [];
      for (let i = 1; i < rows.length; i++) rets.push(Math.abs((rows[i].close / rows[i - 1].close - 1) * 100));
      return mean(rets);
    },
  };
}

const classify = (title) => /Fed Meeting|FOMC/i.test(title) ? (/(Day 1)/.test(title) ? null : 'FOMC decision')
  : /CPI/i.test(title) ? 'CPI report'
  : /Employment/i.test(title) ? 'Jobs report'
  : /GDP/i.test(title) ? 'GDP estimate' : null;

async function macroStudy() {
  const today = new Date().toISOString().slice(0, 10);

  // Event dates by type. FOMC history from the Fed page; everything else from
  // whatever has accumulated in macro_events (deduped against the Fed set).
  const byType = new Map(); // type -> Set of dates
  const add = (type, d) => { if (!byType.has(type)) byType.set(type, new Set()); byType.get(type).add(d); };
  for (const d of await pastFomcDecisionDates()) if (d < today) add('FOMC decision', d);
  const { data: seeded } = await supabase.from('macro_events').select('event_date,title').lt('event_date', today);
  for (const e of seeded || []) {
    const type = classify(e.title);
    if (type) add(type, e.event_date);
  }

  const [spxRows, niftyRows, tnxRows, fiiQ] = await Promise.all([
    chartCloses('^GSPC', '2020-12-01'),
    chartCloses('^NSEI', '2020-12-01'),
    chartCloses('^TNX', '2020-12-01'),
    supabase.from('fii_dii_activity').select('trade_date,fii_net'),
  ]);
  const spx = makeSeries(spxRows), nifty = makeSeries(niftyRows), tnx = makeSeries(tnxRows);
  const fiiByDate = new Map((fiiQ.data || []).map(r => [r.trade_date, r.fii_net]));

  const types = [];
  for (const [type, dateSet] of byType) {
    const dates = [...dateSet].sort();
    const spyRets = [], tnxBps = [], niftyNextRets = [], fiiNets = [];
    let niftyNextDown = 0;
    for (const d of dates) {
      const s = spx.retOn(d);
      if (s != null) spyRets.push(s);
      const t = tnx.deltaOn(d);
      if (t != null) tnxBps.push(t * 100); // ^TNX is in percent → bps
      const n = nifty.nextSession(d);
      if (n) {
        niftyNextRets.push(n.ret);
        if (n.ret < 0) niftyNextDown++;
        const f = fiiByDate.get(n.date);
        if (f != null) fiiNets.push(f);
      }
    }
    if (!spyRets.length) continue;
    types.push({
      type,
      n: dates.length,
      from: dates[0], to: dates[dates.length - 1],
      spx: {
        avgAbs: r2(mean(spyRets.map(Math.abs))),
        pctOver1: r2((spyRets.filter(v => Math.abs(v) >= 1).length / spyRets.length) * 100),
        avg: r2(mean(spyRets)),
      },
      us10y: { avgAbsBps: r2(mean(tnxBps.map(Math.abs))) },
      niftyNext: {
        n: niftyNextRets.length,
        avgAbs: r2(mean(niftyNextRets.map(Math.abs))),
        pctDown: niftyNextRets.length ? r2((niftyNextDown / niftyNextRets.length) * 100) : null,
      },
      fiiNext: { n: fiiNets.length, avgNetCr: r2(mean(fiiNets)) },
    });
  }
  types.sort((a, b) => b.n - a.n);

  return {
    types,
    baseline: {
      spxAvgAbs: r2(spx.avgAbsRet()),
      niftyAvgAbs: r2(nifty.avgAbsRet()),
      window: `${spxRows[0]?.date} → ${spxRows[spxRows.length - 1]?.date}`,
    },
    notes: [
      'SPY/10Y measured on the event day (US session); NIFTY and FII flows on the NEXT Indian session — US macro prints land after India closes.',
      'FOMC history is scraped from the official Fed calendar; CPI/jobs/GDP history accumulates from the seeded calendar going forward, so their n grows over time.',
      'FII reaction uses fii_dii_activity, which currently starts 2026-04-23 — small n, read accordingly.',
    ],
    computedAt: new Date().toISOString(),
  };
}

module.exports = { macroStudy };
