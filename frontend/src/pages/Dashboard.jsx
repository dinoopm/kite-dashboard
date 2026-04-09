import { useState, useEffect } from 'react'

function Dashboard() {
  const [data, setData] = useState({
    profile: null,
    holdings: null,
    mfHoldings: null,
    margins: null
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = async (signal) => {
    try {
      setLoading(true);
      setError(null);

      const [profileRes, holdingsRes, mfRes, marginsRes] = await Promise.all([
        fetch('http://localhost:3001/api/profile', { signal }),
        fetch('http://localhost:3001/api/holdings', { signal }),
        fetch('http://localhost:3001/api/mf-holdings', { signal }),
        fetch('http://localhost:3001/api/margins', { signal }),
      ]);
      const profileData = await profileRes.json();
      const holdingsData = await holdingsRes.json();
      const mfData = await mfRes.json();
      const marginsData = await marginsRes.json();

      let p = null, h = null, m = null, cash = null;

      if (profileData?.content?.[0]?.text) {
        try { p = JSON.parse(profileData.content[0].text); } catch(e) {}
      }
      if (holdingsData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(holdingsData.content[0].text);
          h = parsed.data || parsed;
        } catch(e) {}
      }
      if (mfData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(mfData.content[0].text);
          m = parsed.data || parsed;
        } catch(e) {}
      }
      if (marginsData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(marginsData.content[0].text);
          cash = parsed.data || parsed;
        } catch(e) {}
      }

      setData({ profile: p, holdings: h, mfHoldings: m, margins: cash });

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

  if (loading) return <div className="loader"></div>;
  if (error) return <div className="dashboard-layout"><div className="glass-panel"><p className="negative">{error}</p><button onClick={() => fetchData()} style={{padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem'}}>Retry</button></div></div>;

  // Aggregating Stocks
  const stocks = Array.isArray(data.holdings) ? data.holdings : [];
  const totalStockInv = stocks.reduce((sum, h) => sum + (h.average_price * ((h.t1_quantity || 0) + (h.realised_quantity || 0))), 0);
  const totalStockVal = stocks.reduce((sum, h) => sum + (h.last_price * ((h.t1_quantity || 0) + (h.realised_quantity || 0))), 0);
  const stockPl = stocks.reduce((sum, h) => sum + (h.pnl !== undefined ? h.pnl : ((h.last_price - h.average_price) * ((h.t1_quantity || 0) + (h.realised_quantity || 0)))), 0);
  const stockPlPct = totalStockInv ? ((stockPl / totalStockInv) * 100).toFixed(2) : 0;

  // Calculate Top Movers
  let topWinners = [];
  let topLosers = [];
  if (stocks.length > 0) {
    const movers = stocks.map(item => {
      const q = (item.t1_quantity || 0) + (item.realised_quantity || 0);
      const currentValue = q * item.last_price;
      const investment = q * item.average_price;
      const itemPL = item.pnl !== undefined ? item.pnl : (currentValue - investment);
      const itemPLPercent = investment ? (itemPL / investment) * 100 : 0;
      const pChg = item.day_change !== undefined ? item.day_change : (item.last_price - (item.close_price || item.last_price));
      const pChgPct = item.day_change_percentage !== undefined ? item.day_change_percentage : (item.close_price ? ((pChg / item.close_price) * 100) : 0);
      return { ...item, displayQuantity: q, currentValue, investment, itemPL, itemPLPercent, pChg, pChgPct };
    }).sort((a, b) => b.pChgPct - a.pChgPct);
    
    topWinners = movers.filter(m => m.pChgPct > 0).slice(0, 3);
    topLosers = movers.filter(m => m.pChgPct < 0).reverse().slice(0, 3);
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
      <header className="header">
        <div>
          <h1>Overview Dashboard</h1>
          <p>Welcome back, {data.profile?.user_name || "Trader"}</p>
        </div>
        <div className="glass-panel" style={{ padding: '0.5rem 1rem' }}>
          <span className="label">User ID: </span>
          <strong>{data.profile?.user_id}</strong>
        </div>
      </header>

      {/* Net Worth / Grand Totals */}
      <section className="glass-panel" style={{ marginBottom: '2rem', background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        <h2 style={{ marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Net Portfolio</h2>
        <div className="grid">
          <div>
             <span className="label">Total Invested</span>
             <span className="value" style={{ fontSize: '1.5rem' }}>₹{fmt(totalInv)}</span>
          </div>
          <div>
             <span className="label">Total Current Value</span>
             <span className="value" style={{ fontSize: '1.5rem', color: 'var(--accent)' }}>₹{fmt(totalVal)}</span>
          </div>
          <div>
             <span className="label">Total P&L</span>
             <span className={`value ${totalPl >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem' }}>
                {totalPl >= 0 ? '+' : ''}₹{fmt(totalPl)} ({totalPlPct}%)
             </span>
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginBottom: '2rem', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        
        {/* Stocks Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Equities</h3>
            <span style={{ background: 'var(--bg-dark)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem' }}>{stocks.length} Assets</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '0.5rem 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Invested</span>
            <strong>₹{fmt(totalStockInv)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Current</span>
            <strong>₹{fmt(totalStockVal)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">P&L</span>
            <strong className={stockPl >= 0 ? 'positive' : 'negative'}>
              {stockPl >= 0 ? '+' : ''}₹{fmt(stockPl)} ({stockPlPct}%)
            </strong>
          </div>
        </div>

        {/* Mutual Funds Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
           <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Mutual Funds</h3>
            <span style={{ background: 'var(--bg-dark)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem' }}>{mfs.length} Assets</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '0.5rem 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Invested</span>
            <strong>₹{fmt(totalMfInv)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Current</span>
            <strong>₹{fmt(totalMfVal)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">P&L</span>
            <strong className={mfPl >= 0 ? 'positive' : 'negative'}>
              {mfPl >= 0 ? '+' : ''}₹{fmt(mfPl)} ({mfPlPct}%)
            </strong>
          </div>
        </div>

        {/* Cash Margins Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Cash & Margins</h3>
            <span style={{ background: 'var(--bg-dark)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem' }}>Equity</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '0.5rem 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Available Margin (Live)</span>
            <strong style={{ color: 'var(--accent)' }}>₹{fmt(availableMargin)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Opening Balance</span>
            <strong>₹{fmt(openingBalance)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
             <span className="label">Utilised</span>
             <strong>₹{fmt(marginsObj?.equity?.utilised?.debits || 0)}</strong>
          </div>
        </div>

        {/* Today's Movers Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Today's Movers</h3>
            <span style={{ background: 'var(--bg-dark)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem' }}>Equity Top 3</span>
          </div>
          <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '0.5rem 0' }} />
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div>
              <span className="label" style={{ color: 'var(--success)', display: 'block', marginBottom: '0.5rem' }}>Top 3 Winners</span>
              {topWinners.length > 0 ? topWinners.map((gainer, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                  <strong>{gainer.tradingsymbol}</strong>
                  <span className="positive">+{gainer.pChgPct.toFixed(2)}%</span>
                </div>
              )) : (
                <div className="value" style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>--</div>
              )}
            </div>
            
            <div>
               <span className="label" style={{ color: 'var(--danger)', display: 'block', marginBottom: '0.5rem' }}>Top 3 Losers</span>
               {topLosers.length > 0 ? topLosers.map((loser, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                  <strong>{loser.tradingsymbol}</strong>
                  <span className="negative">{loser.pChgPct.toFixed(2)}%</span>
                </div>
              )) : (
                <div className="value" style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>--</div>
              )}
            </div>
          </div>
        </div>

      </section>
    </div>
  )
}

export default Dashboard
