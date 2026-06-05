import { useState } from 'react';
import AlertRow from './AlertRow';
import ConvictionModal from './ConvictionModal';
import TradePlanModal from './TradePlanModal';
import { biasClass } from './biasClass';

// Full technical-alerts panel: bias / breakout / super-flip / early filters,
// symbol search, sortable momentum column, cache-status banner + live stamp,
// and the AlertRow list with conviction / trade-plan modals. Extracted so the
// sector drill-down and theme baskets share one implementation.
//   alerts      — array of alert objects (the `alerts` field of a *-alerts API)
//   summary     — { readyCount, totalConstituents, notReady[] }
//   lastUpdated — Date of the last fetch (for the "● Live" stamp)
export default function TechnicalAlertsPanel({ alerts = [], summary, lastUpdated }) {
  const [alertFilter, setAlertFilter] = useState('all'); // all | bullish | bearish
  const [alertFilterBreakouts, setAlertFilterBreakouts] = useState(false);
  const [alertFilterSuperFlips, setAlertFilterSuperFlips] = useState(false);
  const [alertFilterEarly, setAlertFilterEarly] = useState(false);
  const [alertSearch, setAlertSearch] = useState('');
  const [alertSortDir, setAlertSortDir] = useState('desc');
  const [convictionStock, setConvictionStock] = useState(null);
  const [tradePlanStock, setTradePlanStock] = useState(null);

  const bullishCount = alerts.filter(s => biasClass(s) === 'bullish').length;
  const bearishCount = alerts.filter(s => biasClass(s) === 'bearish').length;
  const breakoutCount = alerts.filter(s => s.isBreakout).length;
  const superFlipCount = alerts.filter(s => s.supertrend?.flippedToBull).length;
  // Early movers — any one of: fresh ST flip, bullish RSI divergence, fresh
  // breakout, buy-side volume ≥1.2× on an up-day. Matches the STRONG BUY floor.
  const isEarlyMover = (s) => {
    if (s.supertrend?.flippedToBull) return true;
    if (s.divergence === 'BUY SETUP') return true;
    if (s.isBreakout) return true;
    if ((s.volSurge ?? 0) >= 1.2 && s.volumeConfirmedSide === 'up') return true;
    return false;
  };
  const earlyCount = alerts.filter(isEarlyMover).length;

  const filtered = alerts
    .filter(s => s.symbol.toLowerCase().includes(alertSearch.toLowerCase()))
    .filter(s => (alertFilter === 'all' ? true : biasClass(s) === alertFilter))
    .filter(s => (alertFilterBreakouts ? s.isBreakout : true))
    .filter(s => (alertFilterSuperFlips ? s.supertrend?.flippedToBull : true))
    .filter(s => (alertFilterEarly ? isEarlyMover(s) : true))
    .slice()
    .sort((a, b) => {
      const dir = alertSortDir === 'desc' ? -1 : 1;
      return ((a.confidence ?? 0) - (b.confidence ?? 0)) * dir;
    });

  const filterPill = (key, label, count) => (
    <button
      key={key}
      onClick={() => setAlertFilter(key)}
      style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', border: alertFilter === key ? '1px solid var(--accent)' : '1px solid var(--border)', background: alertFilter === key ? 'rgba(0, 188, 212, 0.12)' : 'transparent', color: alertFilter === key ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: alertFilter === key ? 600 : 400, fontSize: '0.8rem' }}
    >
      {label}{count !== undefined ? ` (${count})` : ''}
    </button>
  );

  return (
    <div className="glass-panel" style={{ padding: '1rem' }}>
      {summary && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{summary.readyCount}</strong> / {summary.totalConstituents} stocks loaded
            {summary.notReady?.length > 0 && (
              <span style={{ marginLeft: '0.6rem', color: '#f59e0b' }}>
                • {summary.notReady.length} pending — open the Stocks tab to warm the cache
              </span>
            )}
          </div>
          {lastUpdated && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              ● Live · {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Filter row */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {filterPill('all', 'All', alerts.length)}
        {filterPill('bullish', 'Bullish', bullishCount)}
        {filterPill('bearish', 'Bearish', bearishCount)}
        <button
          onClick={() => setAlertFilterBreakouts(v => !v)}
          style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', border: alertFilterBreakouts ? '1px solid #fcd34d' : '1px solid var(--border)', background: alertFilterBreakouts ? 'rgba(252,211,77,0.12)' : 'transparent', color: alertFilterBreakouts ? '#fcd34d' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: alertFilterBreakouts ? 600 : 400, fontSize: '0.8rem' }}
          title="Show only stocks that have crossed their 20-day resistance ceiling"
        >
          🚀 Breakouts{breakoutCount > 0 ? ` (${breakoutCount})` : ''}
        </button>
        <button
          onClick={() => setAlertFilterSuperFlips(v => !v)}
          style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', border: alertFilterSuperFlips ? '1px solid #14F195' : '1px solid var(--border)', background: alertFilterSuperFlips ? 'rgba(20,241,149,0.12)' : 'transparent', color: alertFilterSuperFlips ? '#14F195' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: alertFilterSuperFlips ? 600 : 400, fontSize: '0.8rem' }}
          title="Super-Flip: SuperTrend(10,3) just flipped from red to green on the latest candle — the long-swing strategy's primary entry trigger"
        >
          ⚡ Super-Flips ({superFlipCount})
        </button>
        <button
          onClick={() => setAlertFilterEarly(v => !v)}
          style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', border: alertFilterEarly ? '1px solid #a855f7' : '1px solid var(--border)', background: alertFilterEarly ? 'rgba(168,85,247,0.12)' : 'transparent', color: alertFilterEarly ? '#a855f7' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: alertFilterEarly ? 600 : 400, fontSize: '0.8rem' }}
          title="Early movers: stocks stirring before the full STRONG BUY chain fires. Any one of these trips it — ST just flipped BULL · bullish RSI divergence · fresh breakout · buy-side volume ≥1.2× on up-day."
        >
          ✨ Early ({earlyCount})
        </button>
        <input
          type="text"
          placeholder="Search symbol…"
          value={alertSearch}
          onChange={e => setAlertSearch(e.target.value)}
          style={{ padding: '0.4rem 0.8rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text-primary)', width: '180px', fontSize: '0.85rem', outline: 'none', marginLeft: 'auto' }}
        />
      </div>

      {/* Column Headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(200px, 1.2fr) minmax(240px, 1.5fr) minmax(140px, 1fr) minmax(120px, 0.6fr)', gap: '1rem', padding: '0 1rem 0.5rem 1rem', fontSize: '0.65rem', color: 'var(--text-secondary)', letterSpacing: '1px', fontWeight: 700 }}>
        <div>SYMBOL / PRICE</div>
        <div>CORE TECHNICALS <span className="info-icon">ⓘ</span></div>
        <div style={{ textAlign: 'center' }}>MONEY FLOW <span className="info-icon">ⓘ</span></div>
        <div style={{ textAlign: 'center' }}>TRADE PLAN <span className="info-icon">ⓘ</span></div>
        <div
          onClick={() => setAlertSortDir(d => (d === 'desc' ? 'asc' : 'desc'))}
          style={{ textAlign: 'right', cursor: 'pointer' }}
          title="Click to flip sort direction"
        >
          MOMENTUM {alertSortDir === 'desc' ? '↓' : '↑'}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
          NO SIGNALS MATCH QUERY
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {filtered.map(stock => (
            <AlertRow
              key={stock.symbol}
              stock={stock}
              showHoldingsFields={false}
              onOpenConviction={() => setConvictionStock(stock)}
              onOpenTradePlan={() => setTradePlanStock(stock)}
            />
          ))}
        </div>
      )}

      <ConvictionModal stock={convictionStock} onClose={() => setConvictionStock(null)} />
      <TradePlanModal stock={tradePlanStock} onClose={() => setTradePlanStock(null)} />
    </div>
  );
}
