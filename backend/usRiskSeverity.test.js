const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifySeverity, buildSeverity, buildSeverityTimeline, createSeverityService } = require('./usRiskSeverity');
const calm = { vix: 14, rotation: 1, drawdown: -2, rapidDrawdown: -1, creditChange21: -5, creditChange4: -1 };
test('tiers require all checks; only exact combinations receive a tier', () => {
  assert.equal(classifySeverity(calm).state, 'NEUTRAL');
  assert.equal(classifySeverity({ ...calm, vix: 15, rotation: -1 }).state, 'CAUTION');
  assert.equal(classifySeverity({ ...calm, vix: 20, drawdown: -11, creditChange21: 5 }).state, 'STRESS');
  assert.equal(classifySeverity({ ...calm, vix: 18, rotation: 1 }).state, 'MIXED');
});
test('CRASH MODE needs all three independent conditions and a strict >10% drop', () => {
  const crash = { ...calm, vix: 31, rapidDrawdown: -11, creditChange4: 110 };
  assert.equal(classifySeverity(crash).state, 'CRASH MODE');
  for (const override of [{ vix: 30 }, { rapidDrawdown: -10 }, { creditChange4: 99 }, { creditChange4: null }]) assert.notEqual(classifySeverity({ ...crash, ...override }).state, 'CRASH MODE');
  assert.equal(classifySeverity({ ...crash, creditChange4: null }).state, 'INCOMPLETE');
  assert.equal(classifySeverity(crash, { stale: true }).state, 'INCOMPLETE');
});
function fixture() {
  const dates = [];
  for (let d = new Date('2025-09-01T00:00:00Z'); dates.length < 280; d = new Date(+d + 864e5)) if (![0, 6].includes(d.getUTCDay())) dates.push(d.toISOString().slice(0, 10));
  return { spy: dates.map((date, i) => ({ date, close: 100 + i })), tlt: dates.map(date => ({ date, close: 100 })), vix: dates.map(date => ({ date, close: 14 })), credit: dates.map(date => ({ observation_date: date, value: 3 })) };
}
test('metrics use a common date and SPY session windows; missing credit dates do not shorten four sessions', () => {
  const input = fixture(); const day = input.spy.at(-1).date;
  const now = new Date(`${day}T23:00:00Z`);
  const out = buildSeverity(input, now); assert.equal(out.asOf, day); assert.equal(out.state, 'NEUTRAL');
  assert.equal(out.inputs.rapidFrom, input.spy.at(-5).date);
  const base = input.spy.at(-5).date;
  input.credit = input.credit.filter(p => p.observation_date !== base);
  const missing = buildSeverity(input, now); assert.equal(missing.metrics.creditChange4, null); assert.equal(missing.state, 'INCOMPLETE');
});
test('a missing latest credit observation moves the whole assessment to the preceding common close', () => {
  const input = fixture(); input.credit.pop();
  const result = buildSeverity(input, new Date(`${input.spy.at(-1).date}T23:00:00Z`));
  assert.equal(result.asOf, input.spy.at(-2).date); assert.equal(result.inputs.spyClose, input.spy.at(-2).close);
});
test('a >10% fall over five sessions alone does not satisfy the under-five-session crash rule', () => {
  const input = fixture(); const n = input.spy.length;
  [100, 98, 96, 94, 92, 89.9].forEach((close, i) => { input.spy[n - 6 + i].close = close; });
  const result = buildSeverity(input, new Date(`${input.spy.at(-1).date}T23:00:00Z`));
  assert.ok(result.metrics.rapidDrawdown > -10);
});
test('source failure remains explicit and cannot turn unavailable inputs into Neutral', async () => {
  const input = fixture();
  const get = createSeverityService({ indexFetch: async symbol => input[symbol === 'SPY' ? 'spy' : 'tlt'], vixFetch: async () => input.vix, cccFetch: async () => ({ observations: [] }), creditFetch: async () => { throw Error('offline'); }, now: () => new Date(`${input.spy.at(-1).date}T23:00:00Z`) });
  const result = await get(); assert.equal(result.state, 'INCOMPLETE'); assert.equal(result.warnings.length, 1);
});


test('exact drawdown and credit-spike thresholds survive binary floating-point arithmetic', () => {
  const input = fixture(); const n = input.spy.length;
  for (const point of input.spy) point.close = 100;
  input.spy[n - 1].close = 90;
  for (const point of input.credit) point.value = 3.1;
  input.credit[n - 1].value = 4.1;
  const result = buildSeverity(input, new Date(`${input.spy.at(-1).date}T23:00:00Z`));
  assert.equal(result.metrics.drawdown, -10);
  assert.equal(result.metrics.rapidDrawdown, -10);
  assert.equal(result.metrics.creditChange4, 100);
});


test('historical labels match the current rule and never see future bars', () => {
  const raw = fixture(); const now = new Date(`${raw.spy.at(-1).date}T23:00:00Z`);
  const timeline = buildSeverityTimeline(raw, now);
  const latest = buildSeverity(raw, now);
  assert.equal(timeline.series.at(-1).state, latest.state);
  assert.deepEqual(timeline.series.at(-1).metrics, latest.metrics);
  const before = timeline.series.slice(0, -1);
  raw.spy.at(-1).close = 1; raw.vix.at(-1).close = 80; raw.credit.at(-1).value = 20;
  assert.deepEqual(buildSeverityTimeline(raw, now).series.slice(0, -1), before);
  assert.equal(timeline.source, 'reconstructed');
});
test('missing historical inputs remain unlabelled rather than inheriting a previous tier', () => {
  const raw = fixture(); const lastDate = raw.spy.at(-1).date;
  raw.credit.pop();
  const timeline = buildSeverityTimeline(raw, new Date(`${lastDate}T23:00:00Z`));
  assert.equal(timeline.series.at(-1).state, 'INCOMPLETE');
  assert.equal(timeline.toDate, raw.spy.at(-2).date);
  assert.equal(timeline.series[0].state, 'INCOMPLETE'); // 252-bar warm-up
});

test('days in current tier counts actual contiguous classifications and optional CCC preserves alignment', () => {
  const raw = fixture(), now = new Date(`${raw.spy.at(-1).date}T23:00:00Z`);
  const timeline = buildSeverityTimeline(raw, now); assert.equal(timeline.daysInCurrentTier, 29);
  raw.ccc = [{ observation_date: raw.spy.at(-2).date, value: 10 }];
  assert.equal(buildSeverity(raw, now).asOf, raw.spy.at(-1).date);
  raw.credit = raw.credit.filter(p => p.observation_date !== raw.spy.at(-3).date);
  assert.equal(buildSeverityTimeline(raw, now).daysInCurrentTier, 2);
});
