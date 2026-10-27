# Market risk severity — offline validation

Status: **blocked**. Requested 2007-01-01 → 2026-10-26.

Historical credit vintages unavailable: Bad Request.  The series does not exist in ALFRED but may exist in FRED.  Try setting realtime_start and realtime_end to today's date or removing the realtime_start and realtime_end variables. Supply --input with a documented, timestamped archive covering the full study and warm-up period. No current-history substitute was used.

Rule: us-risk-severity-69076515b991a24d. Study: severity-study-51906dffc3247c3f.

| Tier | Days (%) | Median lead (sessions / calendar days) | False positives (60 sessions) | Lead events / resolved readings |
|---|---:|---:|---:|---:|
| NEUTRAL | Unavailable | Unavailable / Unavailable | Unavailable% | — / — |
| CAUTION | Unavailable | Unavailable / Unavailable | Unavailable% | — / — |
| STRESS | Unavailable | Unavailable / Unavailable | Unavailable% | — / — |
| CRASH MODE | Unavailable | Unavailable / Unavailable | Unavailable% | — / — |
| MIXED | Unavailable | Unavailable / Unavailable | Unavailable% | — / — |
| INCOMPLETE | Unavailable | Unavailable / Unavailable | Unavailable% | — / — |

| Strategy | CAGR (%) | Max drawdown (%) | Sharpe | Whipsaws |
|---|---:|---:|---:|---:|
| Severity de-risking | Unavailable | Unavailable | Unavailable | — |
| Buy-and-hold SPY | Unavailable | Unavailable | Unavailable | — |

Coverage: 2008 GFC: MISSING; 2011 euro crisis: MISSING; 2015–16 energy/China: MISSING; Feb 2018 volmageddon: MISSING; Dec 2018: MISSING; 2020 COVID: MISSING; 2022 bear market: MISSING.

Source diagnostic: current HY history 2023-10-27 → 2026-10-23. Current observations are not historical vintages.

## Definitions and limits

- The base tier thresholds are unchanged; divergence and cross-check flags do not alter the strategy’s tier or exposure.
- Each decision uses only vintage observations available at that exchange-session close. Every input in an assessment uses the same observation date, which may be earlier than the decision date. No missing session is compressed out of a lookback. Archive provenance and the supplied exchange calendar are required.
- Drawdown events are non-overlapping 10% directional-change cycles from a local closing peak. A 10% rebound from the trough starts a new cycle; this includes corrections during long recoveries. Lead time is measured from the first tier entry associated with an event to its first breach. Late entries in an active drawdown retain zero/negative lead times. Persistent states are not repeatedly credited with leading later events.
- False positives are daily tier readings followed by no new 10% peak-to-trough decline in the next 60 SPY sessions, starting from that reading’s close. Existing losses before the reading do not count as a new future decline. The last 60 sessions are right-censored. Daily readings overlap and are not independent trials. Lead-time event counts and daily false-positive denominators are different units.
- Exposure is set from the prior closing assessment and executed at the next session’s open. STRESS targets 50% equities, CRASH MODE 0%; re-entry requires 10 consecutive assessed sessions below the held risk tier. INCOMPLETE resets the recovery streak and preserves exposure. MIXED is below STRESS under the supplied rule.
- The strategy rebalances daily at the open to its target equity fraction, including drift turnover. Both portfolios pay 10 bps one-way turnover cost. SPY raw price returns exclude dividends; cash earns 0%, Sharpe uses a 0% risk-free rate and 252 sessions/year. No leverage, tax or execution-capacity model is assumed.
- A whipsaw is a reversal in target-allocation direction within 10 sessions. CAGR uses elapsed calendar time; max drawdown includes initial capital. Configured overrides are retained in latest.json.
- A complete study exits nonzero when STRESS has zero/negative median lead, or no resolved lead-time events. Data/provenance/coverage failures also exit nonzero. Incomplete runs never replace the unvalidated UI badge with measured performance.
- No threshold optimization or out-of-sample holdout was performed by this fixed-rule study. Even positive historical lead time would not establish a reliable trading edge.
