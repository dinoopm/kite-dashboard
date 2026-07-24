import { useState } from 'react';
import { fmtDate as fmtDisplayDate } from '../lib/formatDate';

// Market-regime strip: S&P 500 internals (from /api/us/breadth) + sector-ETF
// breadth chips computed from rows already loaded for the table.
const breadthColor = (pct) => pct >= 70 ? '#22c55e' : pct < 40 ? '#ef4444' : '#f5c344';

// Plain-language verdicts so the strip reads without knowing the thresholds.
const verdict50 = (pct) =>
  pct >= 70 ? 'Strong rally — most stocks rising'
  : pct < 40 ? 'Weak — most stocks falling'
  : 'Healthy but selective';
const verdict200 = (pct) =>
  pct >= 60 ? 'Bull market intact'
  : pct < 40 ? 'Bear territory'
  : 'Transition zone';

const TIP_50 = 'How many index members trade above their own 50-day average price (short-term pulse). Above 70% = broad rally. 40–70% = mixed, be picky. Below 40% = most stocks weak. Nasdaq 100 row shows whether tech/growth joins the move.';
const TIP_200 = 'How many members trade above their 200-day average (big-picture regime). Above 60% = bull market intact. Below 40% = bear territory. Verdict follows the S&P row.';
const TIP_DIVERGENCE = 'S&P and Nasdaq 100 short-term breadth differ by 15+ points — one side of the market is not confirming the other. Narrow tech = fragile growth rally; broad tech with weak S&P = growth leading a turn.';
const TIP_SECTORS = 'How many of the sector ETFs in this table are above their 50-day average. Broad participation = healthy rally; only a few = narrow, fragile market.';
const TIP_ADV = 'How many sector ETFs are up today. If the index is up but most sectors are red, a few big names are carrying the move.';

const BREADTH_HELP_KEY = 'us-breadth-help-open-v1';

function BreadthStrip({ breadth, ndxBreadth, rows }) {
  const [helpOpen, setHelpOpen] = useState(() => {
    try { return localStorage.getItem(BREADTH_HELP_KEY) !== 'closed'; } catch { return true; }
  });
  const toggleHelp = () => {
    setHelpOpen(o => {
      try { localStorage.setItem(BREADTH_HELP_KEY, o ? 'closed' : 'open'); } catch { /* non-fatal */ }
      return !o;
    });
  };

  const sectorRows = rows.filter(r => r.category === 'sector' && r.aboveSma50 !== null);
  const above = sectorRows.filter(r => r.aboveSma50).length;
  const advRows = rows.filter(r => r.category === 'sector' && r['1D'] !== null);
  const adv = advRows.filter(r => r['1D'] > 0).length;
  if (!breadth && sectorRows.length === 0) return null;

  // Paired card: S&P row (primary, drives the verdict) + Nasdaq 100 row when
  // its fetch succeeded. Both percentages carry their own zone color.
  const stat = (label, sp, ndx, key, verdictFn, tip) => (
    <div title={tip} style={{ padding: '0.6rem 1rem', background: 'var(--card-bg, rgba(255,255,255,0.03))', border: '1px solid var(--border)', borderRadius: '8px', minWidth: '190px', cursor: 'help' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label} ⓘ</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', minWidth: '68px' }}>S&P 500</span>
        <span style={{ fontSize: '1.25rem', fontWeight: 700, color: breadthColor(sp[key]) }}>{sp[key].toFixed(1)}%</span>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{sp[key === 'pctAbove50' ? 'above50' : 'above200']} of {sp.total}</span>
      </div>
      {ndx && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', minWidth: '68px' }}>Nasdaq 100</span>
          <span style={{ fontSize: '1.05rem', fontWeight: 700, color: breadthColor(ndx[key]) }}>{ndx[key].toFixed(1)}%</span>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{ndx[key === 'pctAbove50' ? 'above50' : 'above200']} of {ndx.total}</span>
        </div>
      )}
      <div style={{ fontSize: '0.72rem', color: breadthColor(sp[key]) }}>{verdictFn(sp[key])}</div>
    </div>
  );

  const chip = (text, good, tip) => (
    <span title={tip} style={{ padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, border: '1px solid var(--border)', color: good ? '#22c55e' : '#ef4444', background: good ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', cursor: 'help' }}>{text}</span>
  );

  const sectorPct = sectorRows.length ? above / sectorRows.length : 0;
  const sectorWord = sectorPct >= 0.7 ? 'broad participation' : sectorPct >= 0.4 ? 'mixed participation' : 'narrow — few sectors lead';
  const advWord = advRows.length ? (adv >= advRows.length / 2 ? 'most sectors up today' : 'most sectors down today') : '';

  return (
    <div style={{ margin: '0.8rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
        {breadth && stat('Above 50DMA — short-term', breadth, ndxBreadth, 'pctAbove50', verdict50, TIP_50)}
        {breadth && stat('Above 200DMA — big picture', breadth, ndxBreadth, 'pctAbove200', verdict200, TIP_200)}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {sectorRows.length > 0 && chip(`Sectors above 50DMA: ${above}/${sectorRows.length} — ${sectorWord}`, above >= sectorRows.length / 2, TIP_SECTORS)}
          {advRows.length > 0 && chip(`Advancing today: ${adv}/${advRows.length} — ${advWord}`, adv >= advRows.length / 2, TIP_ADV)}
          {breadth && ndxBreadth && Math.abs(breadth.pctAbove50 - ndxBreadth.pctAbove50) >= 15 && (
            <span title={TIP_DIVERGENCE} style={{ padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, border: '1px solid var(--border)', color: '#f5c344', background: 'rgba(245,195,68,0.08)', cursor: 'help' }}>
              {breadth.pctAbove50 > ndxBreadth.pctAbove50
                ? 'S&P broad but tech narrow — growth rally is thin'
                : 'Tech broader than S&P — growth is leading'}
            </span>
          )}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
          <button onClick={toggleHelp} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '0.7rem', padding: '0.2rem 0.55rem', cursor: 'pointer' }}>
            ⓘ How to read this {helpOpen ? '▴' : '▾'}
          </button>
          {breadth && <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>internals as of {fmtDisplayDate(breadth.asOf)}</span>}
        </div>
      </div>
      {helpOpen && (
        <div style={{ marginTop: '0.6rem', padding: '0.7rem 1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--card-bg, rgba(255,255,255,0.03))', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div><strong style={{ color: 'var(--text-primary)' }}>Breadth</strong> counts how many stocks join the move — the index can be carried by a few giants. Green ≥70% = broad rally · amber 40–70% = selective market · red &lt;40% = broad weakness.</div>
          <div><strong style={{ color: 'var(--text-primary)' }}>Watch for divergence:</strong> index at highs while breadth falls = narrow, fragile rally. Index falling while breadth rises = bottom may be forming.</div>
          <div><strong style={{ color: 'var(--text-primary)' }}>ADX column</strong> measures trend <em>strength</em>, not direction: ≥25 = real trend (green up / red down) · 20–25 = building · &lt;20 = chop, breakouts unreliable. A sector pausing after a big run drops to low ADX — resting, not broken.</div>
        </div>
      )}
    </div>
  );
}


export default BreadthStrip;
