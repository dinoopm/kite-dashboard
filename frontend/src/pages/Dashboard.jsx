import { useState, useEffect } from 'react'

function Dashboard() {
  const [data, setData] = useState({
    profile: null,
    holdings: null,
    mfHoldings: null,
    margins: null,
    indices: null,
    fiiDii: null
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = async (signal) => {
    try {
      setLoading(true);
      setError(null);

      const [profileRes, holdingsRes, mfRes, marginsRes, quotesRes, fiiDiiRes] = await Promise.all([
        fetch('/api/profile', { signal }),
        fetch('/api/holdings', { signal }),
        fetch('/api/mf-holdings', { signal }),
        fetch('/api/margins', { signal }),
        fetch('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: ["NSE:NIFTY 50", "BSE:SENSEX", "NSE:NIFTY 100", "NSE:NIFTY MIDCAP 100", "NSE:NIFTY SMLCAP 100"] }),
          signal
        }),
        fetch('/api/fiidii', { signal }).catch(() => null)
      ]);
      const profileData = await profileRes.json();
      const holdingsData = await holdingsRes.json();
      const mfData = await mfRes.json();
      const marginsData = await marginsRes.json();
      const quotesData = await quotesRes.json();
      const fiiDiiData = fiiDiiRes ? await fiiDiiRes.json() : null;

      let p = null, h = null, m = null, cash = null, idx = null, fd = null;

      if (profileData?.content?.[0]?.text) {
        try { p = JSON.parse(profileData.content[0].text); } catch (e) { }
      }
      if (holdingsData?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(holdingsData.content[0].text);
          h = parsed.data || parsed;
        } catch (e) { }
      }
      if (mfData?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(mfData.content[0].text);
          m = parsed.data || parsed;
        } catch (e) { }
      }
      if (marginsData?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(marginsData.content[0].text);
          cash = parsed.data || parsed;
        } catch (e) { }
      }
      if (quotesData?.content?.[0]?.text) {
        try {
          idx = JSON.parse(quotesData.content[0].text);
        } catch (e) { }
      }
      if (Array.isArray(fiiDiiData)) {
        fd = fiiDiiData;
      }

      setData({ profile: p, holdings: h, mfHoldings: m, margins: cash, indices: idx, fiiDii: fd });

    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err)
      setError(err.message || 'Failed to aggregate dashboard data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [])

  if (loading) return (
    <div className="dashboard-layout" style={{ justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <div className="loader" style={{ width: '48px', height: '48px', borderWidth: '4px' }}></div>
      <p style={{ marginTop: '1rem', color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>SYNCING PORTFOLIO</p>
    </div>
  );
  if (error) return (
    <div className="dashboard-layout">
      <div className="glass-panel" style={{ textAlign: 'center', padding: '4rem 2rem', maxWidth: '500px', margin: '4rem auto' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
        <p className="negative" style={{ fontSize: '1.2rem', marginBottom: '1.5rem' }}>{error}</p>
        <button 
          onClick={() => { const c = new AbortController(); fetchData(c.signal); }} 
          style={{ padding: '0.75rem 2rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '30px', cursor: 'pointer', fontWeight: 600, transition: 'all 0.2s', boxShadow: '0 4px 14px rgba(56, 189, 248, 0.4)' }}
        >
          Retry Connection
        </button>
      </div>
    </div>
  );

  // Aggregating Stocks
  // Use h.quantity (Kite's canonical held qty). t1_quantity + realised_quantity can be 0
  // for stocks in certain settlement states (e.g. ZENTEC: qty=117 but both sub-fields=0),
  // causing them to be silently excluded from Invested/Value totals.
  const stocks = Array.isArray(data.holdings) ? data.holdings : [];
  const totalStockInv = stocks.reduce((sum, h) => sum + (h.average_price * (h.quantity || 0)), 0);
  const totalStockVal = stocks.reduce((sum, h) => sum + (h.last_price * (h.quantity || 0)), 0);
  const stockPl = stocks.reduce((sum, h) => sum + (h.pnl !== undefined ? h.pnl : ((h.last_price - h.average_price) * (h.quantity || 0))), 0);
  const stockPlPct = totalStockInv ? ((stockPl / totalStockInv) * 100).toFixed(2) : 0;

  // Calculate Top Movers
  let topWinners = [];
  let topLosers = [];
  if (stocks.length > 0) {
    const movers = stocks.map(item => {
      const pChg = item.day_change !== undefined ? item.day_change : (item.last_price - (item.close_price || item.last_price));
      const pChgPct = item.day_change_percentage !== undefined ? item.day_change_percentage : (item.close_price ? ((pChg / item.close_price) * 100) : 0);
      return { ...item, pChg, pChgPct };
    }).sort((a, b) => b.pChgPct - a.pChgPct);

    topWinners = movers.filter(m => m.pChgPct > 0).slice(0, 3);
    topLosers = movers.filter(m => m.pChgPct < 0).sort((a, b) => a.pChgPct - b.pChgPct).slice(0, 3); // Bug fix: avoiding .reverse() mutation
  }

  // Aggregating MFs
  const mfs = Array.isArray(data.mfHoldings) ? data.mfHoldings : [];
  const totalMfInv = mfs.reduce((sum, m) => sum + (m.average_price * m.quantity), 0);
  const totalMfVal = mfs.reduce((sum, m) => sum + (m.last_price * m.quantity), 0);
  const mfPl = totalMfVal - totalMfInv;
  const mfPlPct = totalMfInv ? ((mfPl / totalMfInv) * 100).toFixed(2) : 0;

  // Overall Total
  const totalInv = totalStockInv + totalMfInv;
  const totalVal = totalStockVal + totalMfVal;
  const totalPl = totalVal - totalInv;
  const totalPlPct = totalInv ? ((totalPl / totalInv) * 100).toFixed(2) : 0;

  // Cash / Margins
  const marginsObj = data.margins || {};
  const availableMargin = marginsObj?.equity?.available?.live_balance || marginsObj?.equity?.net || 0;
  const openingBalance = marginsObj?.equity?.available?.opening_balance || 0;

  const fmt = (num) => num.toLocaleString('en-IN', { maximumFractionDigits: 2 });

  return (
    <div className="dashboard-layout">
      {/* Header */}
      <header className="header" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '1.5rem', marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2.5rem', margin: '0 0 0.5rem 0', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Dashboard</h1>
          <p style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-secondary)' }}>Welcome back, <strong style={{ color: 'var(--text-primary)' }}>{data.profile?.user_name || "Trader"}</strong></p>
        </div>
        <div className="glass-panel" style={{ padding: '0.6rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', borderRadius: '30px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 10px var(--success)' }}></div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>User ID:</span>
          <strong style={{ letterSpacing: '0.05em' }}>{data.profile?.user_id}</strong>
        </div>
      </header>

      {/* Major Indices */}
      {data.indices && (
        <section style={{ display: 'flex', gap: '1rem', marginBottom: '2.5rem', flexWrap: 'wrap' }}>
          {Object.entries(data.indices).map(([symbol, quote]) => {
            const name = symbol.split(':')[1];
            // Provide a fallback if net_change wasn't explicitly available
            const change = quote.net_change !== undefined ? quote.net_change : (quote.last_price - (quote.ohlc?.close || quote.last_price));
            const changePct = quote.ohlc?.close ? parseFloat(((change / quote.ohlc.close) * 100).toFixed(2)) : 0;
            const isPositive = change >= 0;
            return (
              <div key={symbol} className="glass-panel stat-card" style={{ flex: '1', minWidth: '220px', padding: '1.25rem', background: 'linear-gradient(145deg, rgba(30,41,59,0.8) 0%, rgba(15,23,42,0.9) 100%)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <span className="label" style={{ margin: 0 }}>{name}</span>
                  <div style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', background: isPositive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: isPositive ? 'var(--success)' : 'var(--danger)', fontSize: '0.75rem', fontWeight: 600 }}>
                    {isPositive ? '▲' : '▼'} {changePct.toFixed(2)}%
                  </div>
                </div>
                <span className="value" style={{ fontSize: '1.75rem' }}>{fmt(quote.last_price)}</span>
                <span className={`label ${isPositive ? 'positive' : 'negative'}`} style={{ marginTop: '0.25rem', marginBottom: 0, textTransform: 'none' }}>
                  {isPositive ? '+' : ''}{change.toFixed(2)} pts
                </span>
              </div>
            );
          })}
        </section>
      )}

      {/* Net Worth / Grand Totals */}
      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-primary)' }}>
          <span style={{ color: 'var(--accent)' }}>✦</span> Net Portfolio
        </h2>
        <div className="grid">
          <div className="glass-panel stat-card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--text-secondary)' }}>
            <span className="label">Total Invested</span>
            <span className="value">₹{fmt(totalInv)}</span>
          </div>
          <div className="glass-panel stat-card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--accent)' }}>
            <span className="label">Total Current Value</span>
            <span className="value" style={{ color: 'var(--accent)' }}>₹{fmt(totalVal)}</span>
          </div>
          <div className="glass-panel stat-card" style={{ padding: '1.5rem', borderLeft: `4px solid ${totalPl >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
            <span className="label">Total P&L</span>
            <span className={`value ${totalPl >= 0 ? 'positive' : 'negative'}`}>
              {totalPl >= 0 ? '+' : ''}₹{fmt(totalPl)}
            </span>
            <span className={`label ${totalPl >= 0 ? 'positive' : 'negative'}`} style={{ marginTop: '0.25rem', marginBottom: 0, textTransform: 'none' }}>
              {totalPl >= 0 ? '▲' : '▼'} {totalPlPct}% Overall Return
            </span>
          </div>
        </div>
      </section>

      {/* Detailed Breakdown */}
      <section className="grid" style={{ marginBottom: '2rem', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>

        {/* Stocks Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem' }}>Equities</h3>
            <span style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'var(--accent)', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>{stocks.length} ASSETS</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.05)', margin: '0' }} />
          <div className="stat-card" style={{ marginTop: '0.5rem' }}>
            <span className="label">Current Value</span>
            <span className="value" style={{ fontSize: '1.75rem' }}>₹{fmt(totalStockVal)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', marginTop: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invested</span>
              <span style={{ fontWeight: 500 }}>₹{fmt(totalStockInv)}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' }}>P&L</span>
              <strong className={stockPl >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.95rem' }}>
                {stockPl >= 0 ? '▲' : '▼'} ₹{fmt(Math.abs(stockPl))} ({stockPlPct}%)
              </strong>
            </div>
          </div>
        </div>

        {/* Mutual Funds Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem' }}>Mutual Funds</h3>
            <span style={{ background: 'rgba(162, 155, 254, 0.1)', color: '#a29bfe', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>{mfs.length} ASSETS</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.05)', margin: '0' }} />
          <div className="stat-card" style={{ marginTop: '0.5rem' }}>
            <span className="label">Current Value</span>
            <span className="value" style={{ fontSize: '1.75rem' }}>₹{fmt(totalMfVal)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', marginTop: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invested</span>
              <span style={{ fontWeight: 500 }}>₹{fmt(totalMfInv)}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' }}>P&L</span>
              <strong className={mfPl >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.95rem' }}>
                {mfPl >= 0 ? '▲' : '▼'} ₹{fmt(Math.abs(mfPl))} ({mfPlPct}%)
              </strong>
            </div>
          </div>
        </div>

        {/* Cash Margins Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem' }}>Cash & Margins</h3>
            <span style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>LIVE</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.05)', margin: '0' }} />
          <div className="stat-card" style={{ marginTop: '0.5rem' }}>
            <span className="label">Available Margin</span>
            <span className="value" style={{ fontSize: '1.75rem', color: 'var(--accent)' }}>₹{fmt(availableMargin)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', marginTop: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Opening</span>
              <span style={{ fontWeight: 500 }}>₹{fmt(openingBalance)}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' }}>Utilised</span>
              <span style={{ fontWeight: 500, color: 'var(--danger)' }}>₹{fmt(marginsObj?.equity?.utilised?.debits || 0)}</span>
            </div>
          </div>
        </div>

        {/* Today's Movers Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem' }}>Today's Movers</h3>
            <span style={{ background: 'rgba(243, 156, 18, 0.1)', color: '#f39c12', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>TOP 3 EQUITY</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.05)', margin: '0' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem', flex: 1 }}>
            {/* Winners */}
            <div style={{ background: 'rgba(16, 185, 129, 0.05)', padding: '0.8rem', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.1)' }}>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--success)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.6rem' }}>Top Winners</div>
              {topWinners.length > 0 ? topWinners.map((gainer, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: idx !== topWinners.length - 1 ? '0.4rem' : '0' }}>
                  <strong style={{ fontSize: '0.9rem' }}>{gainer.tradingsymbol}</strong>
                  <span className="positive" style={{ fontSize: '0.9rem', fontWeight: 600 }}>+{gainer.pChgPct.toFixed(2)}%</span>
                </div>
              )) : (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>No gainers today</div>
              )}
            </div>

            {/* Losers */}
            <div style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '0.8rem', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.1)', marginTop: 'auto' }}>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--danger)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.6rem' }}>Top Losers</div>
              {topLosers.length > 0 ? topLosers.map((loser, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: idx !== topLosers.length - 1 ? '0.4rem' : '0' }}>
                  <strong style={{ fontSize: '0.9rem' }}>{loser.tradingsymbol}</strong>
                  <span className="negative" style={{ fontSize: '0.9rem', fontWeight: 600 }}>{loser.pChgPct.toFixed(2)}%</span>
                </div>
              )) : (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>No losers today</div>
              )}
            </div>
          </div>
        </div>

        {/* FII/DII Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem' }}>Institutional Activity</h3>
            <span style={{ background: 'rgba(236, 72, 153, 0.1)', color: '#ec4899', padding: '0.3rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>FII / DII</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.05)', margin: '0' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem', flex: 1 }}>
            {data.fiiDii && data.fiiDii.length > 0 ? (
              data.fiiDii.slice(0, 1).map((day, idx) => {
                const isFIIPos = day.fii_net >= 0;
                const isDIIPos = day.dii_net >= 0;
                const totalNet = day.fii_net + day.dii_net;
                const isTotalPos = totalNet >= 0;
                return (
                  <div key={idx} style={{ background: 'rgba(0,0,0,0.2)', padding: '0.8rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>{day.trade_date}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                      <span style={{ fontSize: '0.85rem' }}>FII Net:</span>
                      <span className={isFIIPos ? 'positive' : 'negative'} style={{ fontSize: '0.85rem', fontWeight: 600 }}>{isFIIPos ? '+' : ''}₹{fmt(day.fii_net)} Cr</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                      <span style={{ fontSize: '0.85rem' }}>DII Net:</span>
                      <span className={isDIIPos ? 'positive' : 'negative'} style={{ fontSize: '0.85rem', fontWeight: 600 }}>{isDIIPos ? '+' : ''}₹{fmt(day.dii_net)} Cr</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.4rem' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>Net Flow:</span>
                      <span className={isTotalPos ? 'positive' : 'negative'} style={{ fontSize: '0.85rem', fontWeight: 700 }}>{isTotalPos ? '+' : ''}₹{fmt(totalNet)} Cr</span>
                    </div>
                  </div>
                );
              })
            ) : (
               <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>No data available. Restart backend server to sync.</div>
            )}
          </div>
        </div>

      </section>
    </div>
  )
}

export default Dashboard
