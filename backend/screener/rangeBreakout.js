'use strict';

const RULE_VERSION = 'range-relative-breakout-v1';
const LOOKBACK = 30;
const VOLUME_LOOKBACK = 20;
const CONFIRM_SESSIONS = 3;
const RS_LOOKBACK = 20;
const EMPTY = {
  rangeBreakoutStatus: null, rangeBreakoutAge: null, rangeBreakoutDate: null,
  rangeBreakoutLevel: null, rangeBreakoutBasePct: null, rangeBreakoutVol: null,
  rangeBreakoutDistance: null, rangeBreakoutRs: null, relativeReturn20d: null,
};
const number = value => value == null || value === '' || typeof value === 'boolean' ? NaN : Number(value);
const positive = value => Number.isFinite(number(value)) && number(value) > 0;
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

function priorRange(candles, index, length) {
  if (index < length) return null;
  const bars = candles.slice(index - length, index);
  if (bars.some(bar => !positive(bar.high) || !positive(bar.low) || number(bar.high) < number(bar.low))) return null;
  return { high: Math.max(...bars.map(bar => number(bar.high))), low: Math.min(...bars.map(bar => number(bar.low))) };
}

function relativeAt(candles, index, benchmark) {
  if (index < RS_LOOKBACK) return null;
  const bars = candles.slice(index - RS_LOOKBACK, index + 1);
  if (bars.some(bar => !positive(bar.close) || !positive(benchmark.get(dateKey(bar.date))))) return null;
  const ratios = bars.map(bar => number(bar.close) / benchmark.get(dateKey(bar.date)));
  const first = bars[0], last = bars.at(-1);
  return {
    high: ratios.at(-1) > Math.max(...ratios.slice(0, -1)),
    excess: (number(last.close) / number(first.close) - benchmark.get(dateKey(last.date)) / benchmark.get(dateKey(first.date))) * 100,
  };
}

// All windows exclude the trigger bar. Time confirmation uses only sessions
// already present in the input; the newest three sessions remain PENDING.
function rangeBreakoutFields(candles, benchmarkCandles = []) {
  const out = { ...EMPTY };
  if (!Array.isArray(candles) || candles.length < LOOKBACK + 2) return out;
  const n = candles.length, last = n - 1;
  const benchmark = new Map(benchmarkCandles.filter(bar => positive(bar?.close) && dateKey(bar.date)).map(bar => [dateKey(bar.date), number(bar.close)]));
  const newestBenchmark = [...benchmark.keys()].sort().at(-1);
  const aligned = newestBenchmark && newestBenchmark === dateKey(candles[last].date);
  if (aligned) out.relativeReturn20d = relativeAt(candles, last, benchmark)?.excess ?? null;
  let event = null;
  let lastAccepted = -Infinity;
  for (let i = LOOKBACK + 1; i < n; i++) {
    const range = priorRange(candles, i, LOOKBACK), previous = priorRange(candles, i - 1, LOOKBACK);
    if (!range || !previous || !positive(candles[i].close) || !positive(candles[i - 1].close)) continue;
    if (!(number(candles[i].close) > range.high && number(candles[i - 1].close) <= previous.high)) continue;
    if (i - lastAccepted < 10) continue;
    const volumes = candles.slice(i - VOLUME_LOOKBACK, i).map(bar => number(bar.volume));
    if (volumes.some(value => !Number.isFinite(value) || value < 0)) continue;
    const average = volumes.reduce((sum, value) => sum + value, 0) / VOLUME_LOOKBACK;
    if (!(average > 0 && positive(candles[i].volume))) continue;
    const volumeRatio = number(candles[i].volume) / average;
    if (volumeRatio < 1.5) continue;
    const following = candles.slice(i + 1, i + 1 + CONFIRM_SESSIONS);
    const valid = following.every(bar => positive(bar.close));
    const failed = following.some(bar => positive(bar.close) && number(bar.close) < range.high);
    const status = failed ? 'FAILED' : valid && following.length === CONFIRM_SESSIONS ? 'CONFIRMED' : 'PENDING';
    const strength = aligned ? relativeAt(candles, i, benchmark) : null;
    event = {
      rangeBreakoutStatus: status, rangeBreakoutAge: last - i, rangeBreakoutDate: dateKey(candles[i].date),
      rangeBreakoutLevel: range.high, rangeBreakoutBasePct: (range.high / range.low - 1) * 100,
      rangeBreakoutVol: volumeRatio,
      rangeBreakoutDistance: positive(candles[last].close) ? (number(candles[last].close) / range.high - 1) * 100 : null,
      rangeBreakoutRs: strength == null ? null : strength.high ? 'YES' : 'NO',
    };
    if (status !== 'FAILED') lastAccepted = i;
  }
  return { ...out, ...event };
}

module.exports = { rangeBreakoutFields, RULE_VERSION, LOOKBACK, CONFIRM_SESSIONS, RS_LOOKBACK };
