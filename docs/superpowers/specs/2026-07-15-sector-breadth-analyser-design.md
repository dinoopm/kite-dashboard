# Sector Breadth Analyser — Design

**Date:** 2026-07-15
**Pages:** `SectorDetail.jsx` (`/sector/:id`, India) and `UsSectorDetail.jsx` (`/us/sector/:id`, US)

## Problem

Both sector-detail pages already render a "Moving Average Breadth" block: two cards
showing % of the sector's stocks above SMA20 / SMA200 with above/below name lists.
That is a single dimension of breadth. Users want a consolidated *breadth analyser*
that reads the sector's internal health across several dimensions at a glance, with a
single plain-language verdict.

All required inputs are already computed per stock and held in `enrichedStockData`
on both pages (`aboveSma20`, `aboveSma200`, `rsi14`, `breakout` rank, `1D`, `name`).
No backend work, no new data fetch, no polling — the analyser is a pure derivation of
rows already loaded, and recomputes as rows stream in.

## Scope

Add four dimensions beyond the existing SMA cards:

1. **Advance / Decline** — count of stocks up vs down today (`1D`).
2. **New Highs vs Lows** — from the `breakout` rank (≥2 = at a new high, 1 = near, 0 = below).
3. **RSI distribution** — overbought (RSI ≥ 70) / oversold (≤ 30) / neutral counts.
4. **Overall breadth verdict** — a deterministic 0–100 composite score plus a
   plain-language read (Strong / Mixed / Weak).

The existing SMA20/200 name-list cards are **kept** (folded into the new panel).

## Architecture

Two new shared files; both pages consume them, replacing their duplicated local code.

### `frontend/src/lib/sectorBreadth.js` (pure)

`computeSectorBreadth(rows) -> null | breadth`

- Filters to loaded rows (`aboveSma20 !== null`). Returns `null` if none loaded.
- Returns:
  - `advDecline: { adv, dec, flat, total, pctAdv }` — from `1D` (>0 adv, <0 dec, ===0 flat).
    Rows with `1D == null` excluded from this dimension's total.
  - `newHighsLows: { atHigh, near, below, total }` — from `breakout`
    (`>=2` atHigh, `===1` near, `===0` below; `null` excluded).
  - `rsiDist: { overbought, oversold, neutral, total }` — RSI ≥70 / ≤30 / else
    (`null` excluded).
  - `sma: { pct20, pct200, above20names, below20names, above200names, below200names }`
    — same values the current `maGaugeData` memo produces.
  - `composite: { score, verdict, read }` — see formula below.

**Composite formula (transparent, deterministic):**

```
newHighParticipation = (atHigh + 0.5 * near) / total            // 0..1
oversoldRate         = oversold / total                          // 0..1
oversoldPenalty      = clamp((oversoldRate - 0.40) / 0.60, 0, 1) * 10   // 0..10

score = 0.30 * pct20
      + 0.25 * pct200
      + 0.20 * pctAdv
      + 0.25 * (100 * newHighParticipation)
      - oversoldPenalty
score = clamp(round(score), 0, 100)

verdict = score >= 66 ? 'Strong' : score >= 40 ? 'Mixed' : 'Weak'
```

Weights sum to 1.0 before the penalty. Each dimension degrades gracefully: if a
dimension has zero loaded rows its term contributes 0 (guard divide-by-zero).

`read` is a short fixed string keyed off the verdict (no LLM):
- Strong: "Broad participation — most of the sector is trending up."
- Mixed: "Selective — a portion of the sector leads, be picky."
- Weak: "Narrow / weak — few names holding up."

### `frontend/src/components/SectorBreadthPanel.jsx` (presentational)

Props: `{ breadth }` (the object above, or `null` while loading).

Renders:
- **Verdict pill** — composite score + `read`, colored by zone (green ≥66 / amber ≥40 / red).
- **Stat-tile row** — one tile each: Advance/Decline, New Highs vs Lows, RSI distribution,
  Above SMA20, Above SMA200. Each tile shows the headline number, the raw counts, and a
  zone color, with a `title` tooltip (same idiom as the US `BreadthStrip` on `UsIndices.jsx`).
- **SMA detail cards** — the existing above/below name-list cards. `MaBreadthCard` is
  **moved into this file** (deduped from both pages) and reused here.
- Loading state: if `breadth == null`, render "Loading SMA data…" (matches current copy).

Styling matches the existing panels: `rgba(255,255,255,0.03)` card bg,
`1px solid rgba(255,255,255,0.08)` border, `var(--text-*)` tokens, zone colors
green `#10b981` / amber `#eab308` / red `#ef4444`.

## Wiring (both pages, identical)

Replace on each page:
- Delete local `MaBreadthCard` function (now shared).
- Replace `maGaugeData` memo with
  `const sectorBreadth = useMemo(() => computeSectorBreadth(enrichedStockData), [enrichedStockData]);`
- Replace the `{/* MA Breadth */}` render block with `<SectorBreadthPanel breadth={sectorBreadth} />`.
- Add imports for `computeSectorBreadth` and `SectorBreadthPanel`.

## Non-goals

- No SMA50 (pages compute 20/200 only).
- No backend endpoint, no historical breadth trend/timeseries.
- No LLM narration — verdict is deterministic factor math.
- No new dependencies.

## Testing / Verification

- Unit-check `computeSectorBreadth` against a small hand-built row array
  (known adv/dec, RSI, breakout, SMA flags) → assert each field and the composite score.
- Browser verify both routes (`/sector/:id`, `/us/sector/:id`): panel renders, tiles
  populate as rows stream, verdict color matches score, no console errors.
