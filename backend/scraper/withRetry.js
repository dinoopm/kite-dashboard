// ─── Retry for the NSE live-analysis scrapers ────────────────────────────────
//
// On 2026-11-02 the Market Data Sync run lost a day of movers: Top Gainers/
// Losers and Volume Gainers both failed fast, wrote nothing, while Large Deals,
// 52-week and Bhavcopy in the SAME run all wrote that day's rows. NSE was
// reachable and Chrome launched; only those two page loads failed, once, out
// of eleven consecutive runs. That is the signature of an intermittent block
// on NSE's market-data pages from cloud IPs, not of anything wrong in the code,
// and the data is unrecoverable afterwards because the live page moves on to
// the next session.
//
// So each capture gets a few attempts, each in a FRESH browser — a session NSE
// has just reset is not one to keep reusing — with a doubling pause between.
//
// Giving up stays loud. A green run over missing data is the one outcome worse
// than a red one, so the final error names every attempt's cause; the job log
// then says what went wrong instead of leaving a bare exit code to interpret.

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(label, attempts, fn, { sleep = sleepMs, log = console.warn, baseDelayMs = 15000 } = {}) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const msg = err?.message || String(err);
      errors.push(`attempt ${attempt}: ${msg}`);
      if (attempt < attempts) {
        const wait = baseDelayMs * 2 ** (attempt - 1);
        log(`${label} attempt ${attempt}/${attempts} failed (${msg}) — retrying in ${Math.round(wait / 1000)}s with a fresh browser`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts — ${errors.join(' | ')}`);
}

module.exports = { withRetry };
