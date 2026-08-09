const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  THRESHOLDS, scale, inflationSignal, labourSignal, wageSignal,
  expectationsSignal, oilSignal, compositeScore, confidence, buildSignals,
} = require('./signals');

describe('scale', () => {
  test('maps the cool end to -1 and the hot end to +1', () => {
    assert.equal(scale(2.0, 2.0, 3.5), -1);
    assert.equal(scale(3.5, 2.0, 3.5), 1);
  });

  test('puts the midpoint at zero', () => {
    assert.ok(Math.abs(scale(2.75, 2.0, 3.5)) < 1e-9);
  });

  test('clamps beyond the ends rather than running away', () => {
    assert.equal(scale(0.5, 2.0, 3.5), -1);
    assert.equal(scale(9.9, 2.0, 3.5), 1);
  });

  // Unemployment cools as it RISES, so its thresholds are inverted. The scale
  // has to handle coolAt > hotAt without a separate code path.
  test('works when cooling is the higher number', () => {
    assert.equal(scale(0.4, 0.4, -0.3), -1);
    assert.equal(scale(-0.3, 0.4, -0.3), 1);
  });

  test('returns null for a missing reading rather than a neutral zero', () => {
    assert.equal(scale(null, 2, 3), null);
    assert.equal(scale(NaN, 2, 3), null);
  });
});

describe('inflationSignal', () => {
  const cool = { seriesId: 'PCEPILFE', latestDate: '2026-06-01', annualized6m: 1.9, annualized3m: 1.6 };
  const hot = { seriesId: 'PCEPILFE', latestDate: '2026-06-01', annualized6m: 3.6, annualized3m: 4.2 };

  test('scores falling sub-target inflation as cooling', () => {
    assert.ok(inflationSignal({ corePce: cool }).score < -0.8);
  });

  test('scores rising above-target inflation as re-accelerating', () => {
    assert.ok(inflationSignal({ corePce: hot }).score > 0.8);
  });

  // The reason momentum is in the score at all: 2.6% falling and 2.6% rising
  // are different worlds, and a level-only score cannot tell them apart.
  test('separates the same level rising from the same level falling', () => {
    const base = { seriesId: 'PCEPILFE', latestDate: '2026-06-01', annualized6m: 2.6 };
    const rising = inflationSignal({ corePce: { ...base, annualized3m: 3.4 } }).score;
    const falling = inflationSignal({ corePce: { ...base, annualized3m: 1.8 } }).score;
    assert.ok(rising > falling, `rising ${rising} should exceed falling ${falling}`);
  });

  // Core PCE publishes ~2 weeks after core CPI, so there are stretches where
  // only CPI has the newest month. Falling back is right; doing it silently is
  // not, because the two run at different levels.
  test('falls back to core CPI and says so', () => {
    const s = inflationSignal({ corePce: null, coreCpi: { seriesId: 'CPILFESL', latestDate: '2026-06-01', annualized6m: 3.0, annualized3m: 3.0 } });
    assert.equal(s.used, 'CPILFESL');
    assert.ok(s.score != null);
  });

  test('returns null when neither core measure is available', () => {
    assert.equal(inflationSignal({}).score, null);
  });
});

describe('labourSignal', () => {
  // A tightening labour market is INFLATIONARY. Strong payrolls score POSITIVE
  // (hike-risk), which inverts the equity-desk reflex that strong jobs are good
  // news — the single easiest sign error in the whole engine.
  test('scores a hot labour market as re-accelerating, not as good news', () => {
    const s = labourSignal({ payrolls: { avg3mChange: 260 }, unemployment: { changePp: -0.4 } });
    assert.ok(s.score > 0.8, `got ${s.score}`);
  });

  test('scores weak hiring and rising unemployment as cooling', () => {
    const s = labourSignal({ payrolls: { avg3mChange: 20 }, unemployment: { changePp: 0.5 } });
    assert.ok(s.score < -0.8, `got ${s.score}`);
  });

  test('works from unemployment alone when payrolls are missing', () => {
    const s = labourSignal({ payrolls: null, unemployment: { changePp: 0.5 } });
    assert.ok(s.score < 0);
    assert.equal(s.detail.unemploymentOnly, true);
  });

  test('returns null when the whole labour block is missing', () => {
    assert.equal(labourSignal({}).score, null);
  });
});

describe('wageSignal and oilSignal', () => {
  test('wage growth below the productivity-consistent pace is cooling', () => {
    assert.ok(wageSignal({ wages: { yoyPct: 3.2 } }).score < -0.8);
  });

  test('wage growth well above it is re-accelerating', () => {
    assert.ok(wageSignal({ wages: { yoyPct: 4.8 } }).score > 0.8);
  });

  test('a collapsing oil price is cooling and a spike is not', () => {
    assert.ok(oilSignal({ oil: { rocPct: -30 } }).score < -0.8);
    assert.ok(oilSignal({ oil: { rocPct: 40 } }).score > 0.8);
  });

  test('both return null without data', () => {
    assert.equal(wageSignal({}).score, null);
    assert.equal(oilSignal({}).score, null);
  });
});

describe('expectationsSignal', () => {
  test('an anchored, falling breakeven is cooling', () => {
    assert.ok(expectationsSignal({ expectations: { latest: 2.05, changePp: -0.3 } }).score < -0.8);
  });

  test('a rising, un-anchored breakeven is re-accelerating', () => {
    assert.ok(expectationsSignal({ expectations: { latest: 2.7, changePp: 0.3 } }).score > 0.8);
  });
});

describe('compositeScore', () => {
  const allAt = (v) => ({
    inflation: { score: v }, labour: { score: v }, wages: { score: v },
    expectations: { score: v }, oil: { score: v },
  });

  test('unanimous cooling produces a cooling regime and a cut-compatible bias', () => {
    const c = compositeScore(allAt(-1));
    assert.equal(c.regime, 'cooling');
    assert.equal(c.bias, 'cut-compatible');
    assert.ok(Math.abs(c.score + 1) < 1e-9);
  });

  test('unanimous heat produces hike-risk', () => {
    assert.equal(compositeScore(allAt(1)).bias, 'hike-risk');
  });

  test('the middle is hold-compatible', () => {
    assert.equal(compositeScore(allAt(0)).regime, 'neutral');
    assert.equal(compositeScore(allAt(0)).bias, 'hold-compatible');
  });

  // Core inflation carries the most weight, so it must be able to outvote a
  // single opposing block on its own.
  test('inflation outweighs any one other signal', () => {
    const c = compositeScore({
      inflation: { score: 1 }, labour: { score: -1 },
      wages: { score: 0 }, expectations: { score: 0 }, oil: { score: 0 },
    });
    assert.ok(c.score > 0, `inflation should dominate labour, got ${c.score}`);
  });

  // Scoring a missing signal as 0 would drag the composite toward Neutral, so
  // a broken feed would render as a genuine "things are balanced" reading.
  test('drops a missing signal and renormalises rather than scoring it zero', () => {
    const c = compositeScore({
      inflation: { score: 1 }, labour: { score: 1 }, wages: { score: 1 },
      expectations: { score: 1 }, oil: { score: null },
    });
    assert.ok(Math.abs(c.score - 1) < 1e-9, `got ${c.score}, a dropped signal must not dilute`);
    assert.ok(Math.abs(c.coverage - 0.95) < 1e-9);
  });

  test('contributions sum to the composite score', () => {
    const c = compositeScore({
      inflation: { score: 0.6 }, labour: { score: -0.2 }, wages: { score: 0.4 },
      expectations: { score: 0.1 }, oil: { score: null },
    });
    const sum = c.contributions.reduce((s, x) => s + (x.contribution || 0), 0);
    assert.ok(Math.abs(sum - c.score) < 1e-9, `contributions ${sum} vs score ${c.score}`);
  });

  test('reports unknown when nothing computed at all', () => {
    const c = compositeScore({ inflation: { score: null }, labour: { score: null }, wages: { score: null }, expectations: { score: null }, oil: { score: null } });
    assert.equal(c.score, null);
    assert.equal(c.regime, 'unknown');
    assert.equal(c.coverage, 0);
  });
});

describe('confidence', () => {
  const fresh = {
    corePce: { releasesBehind: 0, frequency: 'monthly' },
    oil: { releasesBehind: 0, frequency: 'daily' },
  };
  const agreeing = { inflation: { score: 0.6 }, labour: { score: 0.5 }, wages: { score: 0.55 }, expectations: { score: 0.5 }, oil: { score: 0.6 } };
  const conflicting = { inflation: { score: 0.9 }, labour: { score: -0.9 }, wages: { score: 0.8 }, expectations: { score: -0.85 }, oil: { score: 0.1 } };

  test('fresh, complete and agreeing data scores high', () => {
    const c = confidence(agreeing, compositeScore(agreeing), fresh);
    assert.equal(c.level, 'high');
    assert.ok(c.score > 0.75);
  });

  // The case a single headline number hides: +0.9 against -0.9 averages to a
  // confident-looking 0 that means "violently conflicting", not "balanced".
  test('conflicting signals cut confidence even when everything is fresh', () => {
    const c = confidence(conflicting, compositeScore(conflicting), fresh);
    assert.ok(c.agreement < 0.5, `agreement was ${c.agreement}`);
    assert.notEqual(c.level, 'high');
  });

  test('stale data cuts confidence', () => {
    const stale = { corePce: { releasesBehind: 4, frequency: 'monthly' }, oil: { releasesBehind: 60, frequency: 'daily' } };
    const c = confidence(agreeing, compositeScore(agreeing), stale);
    assert.ok(c.freshness < 0.2, `freshness was ${c.freshness}`);
    assert.equal(c.level, 'low');
  });

  test('missing signals cut completeness', () => {
    const partial = { ...agreeing, oil: { score: null }, wages: { score: null } };
    const c = confidence(partial, compositeScore(partial), fresh);
    assert.ok(c.completeness < 1);
  });
});

describe('buildSignals', () => {
  // The end-to-end shape the API and the LLM payload both depend on.
  const metrics = {
    corePce: { seriesId: 'PCEPILFE', latestDate: '2026-06-01', releasesBehind: 0, frequency: 'monthly', annualized6m: 2.4, annualized3m: 2.1 },
    coreCpi: { seriesId: 'CPILFESL', latestDate: '2026-06-01', releasesBehind: 0, frequency: 'monthly', annualized6m: 2.6, annualized3m: 2.3 },
    payrolls: { latestDate: '2026-07-01', releasesBehind: 0, frequency: 'monthly', avg3mChange: 86 },
    unemployment: { latestDate: '2026-07-01', releasesBehind: 0, frequency: 'monthly', changePp: 0.2 },
    wages: { latestDate: '2026-07-01', releasesBehind: 0, frequency: 'monthly', yoyPct: 3.7 },
    oil: { latestDate: '2026-08-03', releasesBehind: 0, frequency: 'daily', rocPct: 12 },
    expectations: { latestDate: '2026-08-07', releasesBehind: 0, frequency: 'daily', latest: 2.28, changePp: 0.05 },
  };

  test('produces every signal, a composite and a confidence block', () => {
    const out = buildSignals(metrics);
    for (const k of ['inflation', 'labour', 'wages', 'expectations', 'oil']) {
      assert.ok(out.signals[k], `missing ${k}`);
    }
    assert.ok(['cooling', 'neutral', 'reaccelerating'].includes(out.composite.regime));
    assert.ok(['high', 'medium', 'low'].includes(out.confidence.level));
  });

  // The output is a bias, never a forecast. Enforced here so a later edit
  // cannot quietly turn it into one.
  test('never emits prediction language', () => {
    const text = JSON.stringify(buildSignals(metrics)).toLowerCase();
    for (const word of ['predict', 'will cut', 'will hike', 'forecast', 'certain', 'guarantee']) {
      assert.ok(!text.includes(word), `output contains forecast language: "${word}"`);
    }
  });

  test('degrades to unknown without throwing when nothing is available', () => {
    const out = buildSignals({});
    assert.equal(out.composite.regime, 'unknown');
    assert.equal(out.confidence.level, 'low');
  });
});
