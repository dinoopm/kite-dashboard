// Run: node signals/backfill.js [fromDate]
//
// Populates signal_emissions over all stored history. Worth doing once rather
// than waiting: bhavcopy already holds months of OHLC, so the price signals can
// have a usable sample today instead of in a year. Idempotent — re-running is
// harmless and is the right fix after a failed partial run.
require('dotenv').config({ path: __dirname + '/../../.env' });
const { recordAll } = require('./record');

const fromDate = process.argv[2] || null;

recordAll({ fromDate })
  .then(r => {
    console.log(`price signals: ${r.price.saved} rows across ${r.price.symbols} liquid symbols`);
    for (const [name, n] of Object.entries(r.price.byName)) console.log(`  ${name}: ${n}`);
    console.log(`  (${r.price.illiquidDropped} of ${r.price.symbolsSeen} symbols below the liquidity floor, ${r.price.skippedShort} with too little history)`);
    console.log(`picks:      ${r.picks.saved} rows`);
    console.log(`52w highs:  ${r.highs.saved} rows`);
  })
  .catch(err => { console.error(err.message); process.exit(1); });
