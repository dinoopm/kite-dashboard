const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { runUsPicksScorecard, factorICFromRows } = require('./scorecard');

const day = (i) => { const d = new Date(Date.UTC(2025, 0, 2)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const cal = Array.from({ length: 60 }, (_, i) => day(i));
const series = (start, step) => cal.map((d, i) => ({ date: d, close: start + i * step }));

describe('factorICFromRows', () => {
  test('a factor whose percentile orders the forward returns has IC +1', () => {
    const seriesBySymbol = { A: series(100, 1), B: series(100, 0.5), C: series(100, 0.1) };
    const rows = [
      { date: day(0), symbol: 'A', momentum_pct: 90, volume_pct: 10 },
      { date: day(0), symbol: 'B', momentum_pct: 50, volume_pct: 50 },
      { date: day(0), symbol: 'C', momentum_pct: 10, volume_pct: 90 },
    ];
    const ic = factorICFromRows(rows, seriesBySymbol, 10);
    assert.equal(ic.momentum.meanIC, 1);
    assert.equal(ic.volume.meanIC, -1);
    assert.equal(ic.momentum.dates, 1);
  });
});

describe('runUsPicksScorecard', () => {
  test('scores recorded rows against SPY and shapes badge entries', async () => {
    const rows = [];
    for (let d = 0; d < 30; d++) for (const [sym, rank] of [['A', 1], ['B', 12]]) {
      rows.push({ date: day(d), symbol: sym, rank, momentum_pct: 80, volume_pct: 50, fifty_two_pct: 50, rel_strength_pct: 50, revisions_pct: 50 });
    }
    const context = async () => ({
      calendar: cal, calendarGaps: [],
      seriesBySymbol: { A: series(100, 2), B: series(100, 1) },
      benchmark: series(400, 0.5), benchmarkSymbol: 'SPY',
    });
    const out = await runUsPicksScorecard({ fetchRows: async () => rows, context });
    assert.equal(out.params.benchmark, 'SPY');
    const top25 = out.signals.find(s => s.signal === 'us_picks_top25');
    assert.ok(top25);
    assert.equal(top25.source, 'recorded');
    assert.match(top25.headline.text, /vs SPY/);
    assert.equal(top25.headline.state, 'positive');
    assert.ok(out.signals.find(s => s.signal === 'us_picks_top10').firings < top25.firings);
  });

  test('says so when nothing is recorded', async () => {
    const out = await runUsPicksScorecard({ fetchRows: async () => [], context: async () => null });
    assert.equal(out.signals.length, 2);
    assert.equal(out.signals[0].headline.state, 'no-data');
  });
});
