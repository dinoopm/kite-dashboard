// ─── /api/us/stock-picks/* ───────────────────────────────────────────────────
// Thin. Every number comes from engine.js / scorecard.js / backtest.js; this
// file only caches and shapes HTTP. Mounted in server.js BEFORE the /api/us
// router so the more specific prefix wins.

const express = require('express');
const { buildUsFactorUniverse, fetchSnapshotHistory, saveDailySnapshot, DEFAULT_WEIGHTS } = require('./engine');
const { runUsPicksScorecard } = require('./scorecard');
const { runUsBacktest } = require('./backtest');
const { generateUsPicksSummary } = require('./summary');

const router = express.Router();

const UNIVERSE_TTL = 30 * 60 * 1000;
const SCORECARD_TTL = 60 * 60 * 1000;
const BACKTEST_TTL = 6 * 60 * 60 * 1000;
let universeCache = null, scorecardCache = null, backtestCache = null;
let universeInflight = null, backtestInflight = null;

const missingTable = (err) => /does not exist|schema cache/i.test(err.message);
const isoMinus = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };

router.get('/', async (req, res) => {
  if (universeCache && Date.now() - universeCache.ts < UNIVERSE_TTL) return res.json({ ...universeCache.data, cached: true });
  try {
    if (!universeInflight) universeInflight = buildUsFactorUniverse().finally(() => { universeInflight = null; });
    const data = await universeInflight;
    universeCache = { data, ts: Date.now() };
    res.json({ ...data, defaultWeights: DEFAULT_WEIGHTS });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, configured: !err.notConfigured });
  }
});

router.get('/history', async (req, res) => {
  const days = Math.min(120, Math.max(2, parseInt(req.query.days, 10) || 45));
  try {
    res.json({ available: true, dates: await fetchSnapshotHistory(isoMinus(days)) });
  } catch (err) {
    if (missingTable(err)) return res.json({ available: false, hint: 'Run `node backend/migrate_us_pick_snapshots.js` and paste the SQL into the Supabase SQL editor to enable US pick history.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/scorecard', async (req, res) => {
  if (scorecardCache && Date.now() - scorecardCache.ts < SCORECARD_TTL) return res.json({ ...scorecardCache.data, cached: true });
  try {
    const data = await runUsPicksScorecard();
    scorecardCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    if (missingTable(err)) return res.json({ available: false, signals: [], hint: 'us_pick_snapshots does not exist yet — run migrate_us_pick_snapshots.js.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest', async (req, res) => {
  try {
    if (!req.query.force && backtestCache && Date.now() - backtestCache.ts < BACKTEST_TTL) return res.json({ ...backtestCache.data, cached: true });
    if (!backtestInflight) backtestInflight = runUsBacktest().finally(() => { backtestInflight = null; });
    const data = await backtestInflight;
    backtestCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/summary', async (req, res) => {
  const { period, regime, weights, picks } = req.body || {};
  if (!period || !regime || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'period, regime and a non-empty picks array are required' });
  }
  try {
    res.json({ summary: await generateUsPicksSummary({ period, regime, weights: weights || DEFAULT_WEIGHTS, picks: picks.slice(0, 25) }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Manual trigger; the scheduled path is dailyJobs.runUsPickSnapshot. */
router.post('/snapshot', async (req, res) => {
  try {
    const universe = await buildUsFactorUniverse();
    res.json(await saveDailySnapshot(universe));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { usPicksRouter: router };
