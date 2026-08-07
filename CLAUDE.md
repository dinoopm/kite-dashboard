# Working rules for this repo

## The standing rule: validate before you add

This dashboard reached ~42k lines, 101 routes and 38 pages with 5 test files. Every
indicator, score and alert asserts something about the future; almost none of them
were ever checked. That imbalance — not missing features — is the thing that makes
the app untrustworthy.

**Do not add a new signal, score, filter or alert until the existing ones have a
track record.** A new feature makes the app look more capable while making it
harder to tell which parts work. If asked for a new signal, say this, then build it
*with* its registry entry and scorecard wiring in the same change.

Concretely, before merging anything that makes a claim about future prices:

1. It is registered in `backend/signals/registry.js` with what makes it fire and
   how much history it needs.
2. It is recorded to `signal_emissions` by `backend/signals/record.js`.
3. It renders a `<SignalScore signal="..." />` badge next to itself in the UI.

If a signal cannot be scored yet, it goes in `BLOCKED_SIGNALS` with the reason
attached, so it shows as visibly unvalidated instead of quietly unvalidated.

## How validation is wired

- `backend/signalScoring.js` — pure forward-return arithmetic. Median alongside
  mean, excess over a benchmark as the headline, unresolved windows counted rather
  than scored as flat. No fetching, fully tested.
- `backend/signals/marketSeries.js` — the shared trading calendar, per-symbol
  closes and benchmark. Both scorers use it so they cannot measure different
  windows.
- `backend/signals/scorecard.js` → `GET /api/signals/scorecard` — every registry
  signal, scored, split by `source`.
- `backend/picks/scorecard.js` → `GET /api/stock-picks/scorecard` — the published
  picks specifically.
- `backend/dataHealth.js` → `GET /api/data-health` — which price tables have holes.

### recorded vs reconstructed

Never pool them. `recorded` rows were written the day the signal fired, before the
outcome existed. `reconstructed` rows were recomputed later from stored OHLC —
faithful, because bhavcopy is not revised and the detectors are causal, but a
weaker standard. Mixing them launders weak evidence into strong.

`picks/backtest.js` is weaker still: it re-runs the ranking engine over past dates
using *today's* surveillance list and revised feeds, so it flatters. Where it and
`picks/scorecard.js` disagree, the scorecard is the honest number.

## Rules for the numbers themselves

- **Signals fire on transitions, not states.** "SuperTrend is bullish" is true for
  forty days; recording it forty times turns one call into forty rows and makes `n`
  look like evidence.
- **Don't count one fact several times.** A composite that checks price against
  seven moving averages is not seven confirmations — `UsInstrument`'s bias score
  scored 100% bullish off a single observation until it was reworked to average
  factor *families*.
- **Horizons are counted in bars, so the calendar must be right.** `nse_bhavcopy`
  has silently dropped traded sessions; always build calendars via
  `marketSeries.mergeCalendars` and report the gaps.
- **Refuse to speak on a small sample.** Below ~20 resolved firings, say "too few
  to judge". A 70% hit rate on seven samples is noise, and rendering it in green is
  how a dashboard talks someone into a bad habit.
- **Excess over a benchmark, not raw return.** In a rising market raw return
  flatters everything.

## Data facts worth knowing

- Supabase DDL cannot run from the JS client. Migrations print SQL for the Supabase
  editor and then verify reachability — follow that pattern
  (`migrate_signal_emissions.js` is the most recent example). `READONLY_DB_URL`
  cannot create tables either.
- `nse_bhavcopy` starts 2026-04-02. VCP's Minervini gate needs a 200-day SMA, so it
  cannot be validated until roughly a year of bhavcopy exists.
- Daily recording runs on a timer in `backend/dailyJobs.js`, with "is it done?"
  answered by querying the database. It used to fire lazily off a page view with a
  flag set before the write succeeded, which is why `stock_pick_snapshots` is
  missing 2026-07-16 and 07-17. Those days cannot be recovered — a snapshot
  reconstructed after the fact is not the same evidence.
- A gap nobody can ever fix is declared in `ACKNOWLEDGED_GAPS` (`dataHealth.js`)
  with its cause, so the integrity banner stops nagging about it and stays
  credible for gaps that *are* actionable. Declaring one is a claim that the cause
  is known and the data is unrecoverable, never a way to quiet an inconvenient
  number — undeclared dates still raise the banner, and the declared ones keep
  showing up as a caveat on the scorecard whose `n` they shorten.

## Style

Match the surrounding code: dense explanatory comments that say *why*, plain
functions over abstractions, deterministic maths with the LLM only ever narrating
already-computed output. Never let an AI brief choose or reorder picks.
