const { test } = require('node:test');
const assert = require('node:assert/strict');

// alpaca.js takes alpacaGet at load, so the stub has to be in place first.
const alpacaData = require('./alpacaData');
const DAY = 864e5;
const now = Date.now();
const history = Array.from({ length: 1465 }, (_, i) => ({
  t: new Date(now - (1465 - i) * DAY).toISOString(), o: 10, h: 10, l: 10, c: 10, v: 1,
}));
alpacaData.alpacaGet = async (path, params) => ({
  bars: history.filter(b => Date.parse(b.t) >= Date.parse(params.start)),
});
const { fetchDailyBars } = require('./alpaca');

// The cache was keyed by symbol alone, so whichever caller came first decided
// the window everyone got for the next hour. Opening a stock page runs the
// 1-year red-flags check first, which made a basket show CRWD's 1Y, 2Y and 3Y
// returns as the same number and cut its earnings history to 4 reports.
test('a short request first does not shorten a later long one', async () => {
  const oneYear = await fetchDailyBars('CRWD', 1);
  const fourYears = await fetchDailyBars('CRWD', 4);
  assert.ok(oneYear.length >= 360 && oneYear.length <= 370, `1y gave ${oneYear.length}`);
  assert.ok(fourYears.length >= 1450, `4y gave ${fourYears.length}`);
});

test('a long request first does not lengthen a later short one', async () => {
  await fetchDailyBars('ZS', 4);
  const twoYears = await fetchDailyBars('ZS', 2);
  assert.ok(twoYears.length >= 725 && twoYears.length <= 735, `2y gave ${twoYears.length}`);
});

test('each window ends at the newest bar', async () => {
  const oneYear = await fetchDailyBars('PANW', 1);
  const fourYears = await fetchDailyBars('PANW', 4);
  assert.equal(oneYear.at(-1).date, fourYears.at(-1).date);
});
