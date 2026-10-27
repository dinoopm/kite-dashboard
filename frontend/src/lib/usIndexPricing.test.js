import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPricingInputs, returnsAtPrice, mergeIndexQuote, quoteLabel, quoteFeedLabel } from './usIndexPricing.js';
test('each quote refresh updates every available return and SMA position from fixed anchors', () => {
  const series = Array.from({ length: 800 }, (_, i) => ({ close: 100 + i }));
  const pricingInputs = historyPricingInputs(series);
  const row = { price: 900, pricingInputs, ...returnsAtPrice(pricingInputs, 900) };
  const next = mergeIndexQuote(row, { last_price: 910, ohlc: { close: 900 }, quote_session: 'after-hours' });
  for (const key of ['1W', '1M', '3M', '6M', '1Y', '2Y', '3Y']) {
    assert.ok(Math.abs((1 + next[key] / 100) / (1 + row[key] / 100) - 910 / 900) < 1e-12);
  }
  assert.ok(Math.abs(next['1D'] - 100 / 90) < 1e-10);
  assert.equal(next.aboveSma50, true); assert.equal(next.dist52WHigh, 0);
  assert.equal(mergeIndexQuote(next, {}).price, 910);
});
test('short history leaves missing periods null, and labels identify the actual quote session', () => {
  const r = returnsAtPrice(historyPricingInputs([{ close: 100 }]), 102);
  assert.equal(r['1M'], null);
  assert.match(quoteLabel({ quoteSession: 'after-hours', quoteAsOf: '2026-10-16T21:00:00Z' }), /After-hours · Oct 16, 5:00 PM ET/);
  assert.equal(quoteFeedLabel('delayed_sip'), '15-min delayed');
  assert.equal(quoteLabel({ token: 'synthetic' }), 'Daily composite');
});
