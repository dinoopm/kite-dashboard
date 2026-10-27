# US market risk severity

React 19 + Vite 8 + Recharts frontend; Express 5 + Node backend. Node >=22.18 is required for native TypeScript type stripping of the shared `thresholds.ts` configuration. There are no new dependencies.

`classify(inputs, config)` is pure and returns the unchanged base tier. `assess` adds criterion checks, role descriptions and independent flags. Credit divergence changes display emphasis only. CRASH MODE is confirmation; STRESS already requires an existing 10% correction. Neither is assumed to warn early.

Live sources: Yahoo Finance daily SPY/TLT prices, Cboe daily VIX, FRED broad HY OAS `BAMLH0A0HYM2`, optional CCC & Lower OAS `BAMLH0A3HYC`. OAS feed units are percent; changes are converted to basis points. Missing optional CCC never changes the base tier or common closing date. Every live input displays its observation date and current retrieval/vintage; unknown publication timestamps are explicitly unknown. Tier and flag transitions are recorded forward with exact inputs. Current-history chart labels remain separate from point-in-time evidence.

## Offline study

From `backend`:

```sh
npm run test:risk
npm run risk:backtest
npm run risk:backtest -- --input /absolute/path/archive.json
npm run risk:backtest -- --input /absolute/path/archive.json --config /absolute/path/overrides.json --out /absolute/path/results
```

The default study covers 2007-01-01 through the latest completed closing date, and requires all seven named crisis windows. Warm-up prices must extend at least 252 SPY sessions before 2007; credit and TLT baselines must also exist. Overrides are a partial JSON object merged into the typed defaults. They change the study fingerprint and cannot replace the live badge unless the live config matches.

Exit codes: 0 complete with positive median STRESS lead; 1 complete but nonpositive or unavailable median STRESS lead; 2 missing or invalid data/provenance/coverage. All outcomes write `report.md`, `latest.json` and CSVs for tiers, strategies, crisis coverage, daily classifications/vintages, event lead times, portfolio equity and allocation trades. A small matching summary is published atomically to `backend/data/us-risk-severity/validation/latest.json`; UI requests only read this artifact. Full reconstruction never runs in a request. Incomplete runs retain the unvalidated badge.

### Source limitation

The connected FRED source rejects historical ALFRED vintages for this ICE series. Current public ICE histories are limited to three years; current values also cannot establish what was known in 2008. Running without `--input` performs this source check and writes an explicit blocked report, never fabricated results. An authenticated market-data archive or documented local archive is required to complete the requested 2007–present study. Relevant documentation:

- https://fred.stlouisfed.org/series/BAMLH0A0HYM2
- https://fred.stlouisfed.org/series/BAMLH0A3HYC
- https://fred.stlouisfed.org/docs/api/fred/realtime_period.html

### Archive contract

```json
{
  "schemaVersion": 1,
  "provenance": {
    "kind": "point-in-time",
    "source": "Name, archive version, acquisition method and release-time policy",
    "calendarSource": "Authoritative complete NYSE/Arca session calendar, including exceptional closures and early closes"
  },
  "sessions": [{
    "date": "2006-01-03",
    "openAt": "2006-01-03T14:30:00Z",
    "closeAt": "2006-01-03T21:00:00Z",
    "spyOpen": 100,
    "spyClose": 101
  }],
  "observations": {
    "SPY": [{"date":"2006-01-03","value":101,"availableAt":"2006-01-03T21:01:00Z","vintage":"original","source":"provider"}],
    "TLT": [{"date":"2006-01-03","value":90,"availableAt":"2006-01-03T21:01:00Z","vintage":"original","source":"provider"}],
    "VIX": [{"date":"2006-01-03","value":14,"availableAt":"2006-01-03T21:01:00Z","vintage":"original","source":"Cboe archive"}],
    "HY_OAS": [{"date":"2006-01-03","value":3.5,"availableAt":"2006-01-04T15:00:00Z","vintage":"original","source":"credit archive"}]
  }
}
```

This is an illustrative schema, not usable study data. Supply every actual session, including warm-up. Optional `CCC_OAS` uses the same observation schema. Append revised versions with their real later `availableAt`; do not overwrite the original. Use consistent unadjusted SPY price units across opens, closes and observations. The supplied sessions define outcome returns and the trading calendar; their authenticity/completeness and the provider's availability policy must be documented. A provenance label alone cannot prove the archive is authentic.

Every observation needs an explicit available-at timestamp with timezone. A date-only vintage cannot be assumed available at that day's equity close; use a documented conservative next-day availability or a provider release timestamp. The replay filters by actual session close, including early closes, selects the latest common observation date across the four required series, and preserves missing calendar bars inside lookbacks. Post-close releases and later revisions cannot affect earlier decisions. The example's after-close prices therefore become visible only on the following session.

### Measurement definitions

- Base rate is the percentage of assessed exchange sessions in each tier, including separate MIXED and INCOMPLETE rows. The full-study gate rejects incomplete sessions.
- Drawdown events use non-overlapping 10% directional-change cycles from local closing peaks. A 10% rebound starts a new cycle, so corrections inside long recoveries can count. Lead is first tier entry to the associated breach (sessions and calendar days). Entries after the breach retain negative lead. Persistent readings are not counted as new warning firings.
- False positives use daily tier readings with no new 10% peak-to-trough drop during the following 60 sessions, measured from that reading onward. Existing losses do not satisfy this future outcome. The last 60 sessions are censored. Daily overlapping readings are not independent event counts.
- The strategy trades only at the next open: STRESS equity 50%, CRASH MODE 0%, normal 100%; re-enter after ten consecutive sessions below held risk. Missing assessments reset the re-entry streak and preserve exposure. Daily target rebalancing includes drift and a configurable illustrative 10 bps one-way turnover cost; both portfolios pay costs. Cash earns zero, SPY price returns exclude dividends, Sharpe uses zero risk-free and 252 sessions/year, CAGR uses calendar time. Whipsaws are reversals of allocation direction within ten sessions.
- The default thresholds cannot produce an early STRESS warning before a correction starting at the same trailing high: the rule itself requires that correction already exists. The lead-time failure gate exposes this limitation; the separate credit-divergence candidate does not silently modify the tier or strategy. No threshold fitting or out-of-sample claim is made. Small event samples remain too few to judge.
