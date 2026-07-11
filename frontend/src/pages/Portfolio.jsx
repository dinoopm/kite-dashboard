import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import EyeIcon from '../components/EyeIcon'

// X-Ray badge palette — same tones the analytics panels use.
const XRAY_TONES = {
  alert: { color: '#f87171', border: 'rgba(239,68,68,0.5)' },
  warn: { color: '#fbbf24', border: 'rgba(251,191,36,0.45)' },
  good: { color: '#34d399', border: 'rgba(52,211,153,0.45)' },
  neutral: { color: 'var(--text-secondary)', border: 'var(--border)' },
}

function XrayBadges({ badges }) {
  if (!badges?.length) return <span style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>—</span>
  return (
    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
      {badges.map(b => {
        const t = XRAY_TONES[b.tone] || XRAY_TONES.neutral
        return (
          <span key={b.id} title={b.detail} style={{
            fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
            color: t.color, border: `1px solid ${t.border}`, borderRadius: '4px', padding: '0.05rem 0.3rem',
            whiteSpace: 'nowrap',
          }}>{b.label}</span>
        )
      })}
    </div>
  )
}

function Portfolio() {
  const [profile, setProfile] = useState(null)
  const [holdings, setHoldings] = useState(null)
  const [xray, setXray] = useState(null) // /api/portfolio/xray — attention scores + badges per holding
  const [mfHoldings, setMfHoldings] = useState(null)
  const [companyNames, setCompanyNames] = useState({}) // symbol -> company name
  const [fundamentals, setFundamentals] = useState({}) // symbol -> { pe, targetMean, currentPrice }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortField, setSortField] = useState('tradingsymbol')
  const [sortDirection, setSortDirection] = useState('asc')
  const [activeTab, setActiveTab] = useState('equity')
  // Privacy toggle — shares the dashboard's localStorage key so the two stay in
  // sync. When on, invested amounts and P&L are masked.
  const [hideAmounts, setHideAmounts] = useState(() => localStorage.getItem('hideAmounts') === '1')
  const toggleHideAmounts = () => setHideAmounts(prev => {
    const next = !prev;
    localStorage.setItem('hideAmounts', next ? '1' : '0');
    return next;
  });

  const navigate = useNavigate()

  const fetchData = async (signal) => {
    try {
      setLoading(true)
      setError(null)

      const [profileRes, holdingsRes, mfRes] = await Promise.all([
        fetch('/api/profile', { signal }),
        fetch('/api/holdings', { signal }),
        fetch('/api/mf-holdings', { signal }),
      ]);
      const profileData = await profileRes.json()
      const holdingsData = await holdingsRes.json()
      const mfData = await mfRes.json()

      if (profileData?.content?.[0]?.text) {
        try { setProfile(JSON.parse(profileData.content[0].text)) } catch(e) {}
      }

      if (holdingsData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(holdingsData.content[0].text) 
          setHoldings(parsed.data ? parsed.data : parsed)
        } catch(e) {}
      }

      if (mfData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(mfData.content[0].text) 
          setMfHoldings(parsed.data ? parsed.data : parsed)
        } catch(e) {}
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err)
      setError(err.message || 'Failed to fetch data from backend.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [])

  // X-Ray loads independently of the holdings table — the first uncached pass
  // can take a while (screener scrape per symbol), so the page never waits on it.
  useEffect(() => {
    let on = true;
    fetch('/api/portfolio/xray')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && j && !j.error) setXray(j) })
      .catch(() => { })
    return () => { on = false };
  }, [])

  // Fetch company names for all equity holdings in bulk after they load.
  useEffect(() => {
    if (!holdings || !holdings.length) return;
    let on = true;
    const symbols = [...new Set(holdings.map(h => h.tradingsymbol))];
    fetch('/api/instrument-names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && j && !j.error) setCompanyNames(j) })
      .catch(() => {})
    return () => { on = false };
  }, [holdings])

  // Fetch P/E + analyst target price for all equity holdings in bulk after they load.
  useEffect(() => {
    if (!holdings || !holdings.length) return;
    let on = true;
    const symbols = [...new Set(holdings.map(h => h.tradingsymbol))];
    fetch('/api/holdings-fundamentals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && j && !j.error) setFundamentals(j) })
      .catch(() => {})
    return () => { on = false };
  }, [holdings])

  if (loading) return <div className="loader"></div>
  if (error) return <div className="dashboard-layout"><div className="glass-panel"><p className="negative">{error}</p><button onClick={() => fetchData()} style={{padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem'}}>Retry</button></div></div>

  const getTotalInvestment = () => {
    if (!holdings || !Array.isArray(holdings)) return 0;
    return holdings.reduce((sum, h) => sum + (h.average_price * ((h.quantity || 0) + (h.t1_quantity || 0))), 0);
  };

  const getCurrentValue = () => {
    if (!holdings || !Array.isArray(holdings)) return 0;
    return holdings.reduce((sum, h) => sum + (h.last_price * ((h.quantity || 0) + (h.t1_quantity || 0))), 0);
  };

  const totalInv = getTotalInvestment();
  const currentVal = getCurrentValue();
  const pl = currentVal - totalInv;
  const plPercentage = totalInv ? ((pl / totalInv) * 100).toFixed(2) : 0;

  const xrayBySymbol = {};
  for (const r of xray?.holdings || []) xrayBySymbol[r.symbol] = r;

  const filteredAndSortedHoldings = (holdings || [])
    .filter(item => {
      const q = searchTerm.toLowerCase();
      return (
        item.tradingsymbol.toLowerCase().includes(q) ||
        (companyNames[item.tradingsymbol] || '').toLowerCase().includes(q)
      );
    })
    .map(item => {
      const q = (item.quantity || 0) + (item.t1_quantity || 0);
      const currentValue = q * item.last_price;
      const investment = q * item.average_price;
      const itemPL = item.pnl !== undefined ? item.pnl : (currentValue - investment);
      const itemPLPercent = investment ? (itemPL / investment) * 100 : 0;
      const dayChange = item.day_change !== undefined ? item.day_change : (item.last_price - (item.close_price || item.last_price));
      const dayChangePct = item.day_change_percentage !== undefined ? item.day_change_percentage : (item.close_price ? (dayChange / item.close_price) * 100 : 0);
      const allocation = currentVal ? (currentValue / currentVal) * 100 : 0;
      const xr = xrayBySymbol[item.tradingsymbol];
      return { ...item, displayQuantity: q, currentValue, investment, itemPL, itemPLPercent, dayChange, dayChangePct, allocation, xrayScore: xr?.score ?? -1, xrayBadges: xr?.badges ?? [] };
    })
    .sort((a, b) => {
      const sortVal = (h) => (sortField === 'pe' || sortField === 'targetMean')
        ? (fundamentals[h.tradingsymbol]?.[sortField] ?? null)
        : h[sortField];
      let valA = sortVal(a);
      let valB = sortVal(b);
      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();
      if (valA == null && valB == null) return 0;
      if (valA == null) return 1;
      if (valB == null) return -1;
      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc'); // default to high-to-low mostly for numbers
    }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span style={{ opacity: 0.3, marginLeft: '4px' }}>↕</span>;
    return <span style={{ marginLeft: '4px' }}>{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const getFilteredAndSortedMFs = () => {
    return (mfHoldings || [])
      .filter(item => {
        const searchStr = (item.fund || item.tradingsymbol || '').toLowerCase();
        return searchStr.includes(searchTerm.toLowerCase());
      })
      .map(item => {
        const q = (item.quantity || 0) + (item.t1_quantity || 0);
        const currentValue = q * item.last_price;
        const investment = q * item.average_price;
        const itemPL = currentValue - investment;
        const itemPLPercent = investment ? (itemPL / investment) * 100 : 0;
        return { ...item, displayQuantity: q, currentValue, investment, itemPL, itemPLPercent };
      })
      .sort((a, b) => {
        let valA = a[sortField];
        let valB = b[sortField];
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
  };

  const filteredAndSortedMFs = getFilteredAndSortedMFs();

  // When privacy mode is on, replace a displayed monetary/return token with dots.
  const priv = (display) => (hideAmounts ? '••••••' : display);

  const csvEscape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const downloadCSV = (filename, headers, rows) => {
    const lines = [headers.map(csvEscape).join(',')];
    rows.forEach(r => lines.push(r.map(csvEscape).join(',')));
    // BOM so Excel reads UTF-8 ₹ and other glyphs correctly
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    const ts = new Date().toISOString().slice(0, 10);
    const num = (v, d = 2) => (v == null || isNaN(v) ? '' : Number(v).toFixed(d));
    if (activeTab === 'equity') {
      const headers = ['Instrument', 'Avg Cost', 'LTP', 'Quantity', 'Invested', 'Current Value', 'Net Change %', 'P&L', 'Day Change', 'Day Change %', 'Allocation %'];
      const rows = filteredAndSortedHoldings.map(h => [
        h.tradingsymbol,
        num(h.average_price),
        num(h.last_price),
        h.displayQuantity,
        num(h.investment),
        num(h.currentValue),
        num(h.itemPLPercent),
        num(h.itemPL),
        num(h.dayChange),
        num(h.dayChangePct),
        num(h.allocation),
      ]);
      downloadCSV(`equity-holdings-${ts}.csv`, headers, rows);
    } else {
      const headers = ['Fund', 'Symbol', 'Avg Cost', 'NAV (LTP)', 'Quantity', 'Invested', 'Current Value', 'Net Change %', 'P&L'];
      const rows = filteredAndSortedMFs.map(h => [
        h.fund || h.tradingsymbol,
        h.tradingsymbol,
        num(h.average_price),
        num(h.last_price),
        h.displayQuantity,
        num(h.investment),
        num(h.currentValue),
        num(h.itemPLPercent),
        num(h.itemPL),
      ]);
      downloadCSV(`mf-holdings-${ts}.csv`, headers, rows);
    }
  };

  const exportDisabled = activeTab === 'equity'
    ? filteredAndSortedHoldings.length === 0
    : filteredAndSortedMFs.length === 0;

  return (
    <div className="dashboard-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button 
            onClick={() => setActiveTab('equity')}
            className={activeTab === 'equity' ? 'active-tab' : 'inactive-tab'}
            style={{
              padding: '0.8rem 1.5rem',
              borderRadius: '12px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: '600',
              background: activeTab === 'equity' ? 'var(--accent)' : 'var(--bg-card)',
              color: '#fff',
              transition: 'all 0.3s ease'
            }}
          >
            Equities
          </button>
          <button 
            onClick={() => setActiveTab('mf')}
            className={activeTab === 'mf' ? 'active-tab' : 'inactive-tab'}
            style={{
              padding: '0.8rem 1.5rem',
              borderRadius: '12px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: '600',
              background: activeTab === 'mf' ? 'var(--accent)' : 'var(--bg-card)',
              color: '#fff',
              transition: 'all 0.3s ease'
            }}
          >
            Mutual Funds
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="text"
            placeholder={`Search ${activeTab === 'equity' ? 'symbols' : 'funds'}...`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--bg-dark)',
              color: 'var(--text-primary)',
              width: '300px',
              outline: 'none'
            }}
          />
          <button
            onClick={toggleHideAmounts}
            title={hideAmounts ? 'Show amounts' : 'Hide amounts'}
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              color: 'var(--text-secondary)',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <EyeIcon off={hideAmounts} />
            {hideAmounts ? 'Show' : 'Hide'}
          </button>
          <button
            onClick={exportCSV}
            disabled={exportDisabled}
            title={exportDisabled ? 'Nothing to export' : `Export ${activeTab === 'equity' ? 'equity' : 'mutual fund'} holdings as CSV`}
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              border: '1px solid rgba(56,189,248,0.25)',
              background: 'rgba(56,189,248,0.08)',
              color: 'var(--accent)',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: exportDisabled ? 'not-allowed' : 'pointer',
              opacity: exportDisabled ? 0.5 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            ⤓ Export CSV
          </button>
        </div>
      </div>

      {activeTab === 'equity' ? (
        <section className="glass-panel animate-in">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h2 style={{ margin: 0 }}>Equity Holdings</h2>
            <Link
              to="/alerts"
              style={{
                textDecoration: 'none',
                padding: '0.5rem 1rem',
                borderRadius: '8px',
                background: 'rgba(56,189,248,0.08)',
                border: '1px solid rgba(56,189,248,0.25)',
                color: 'var(--accent)',
                fontWeight: 700,
                fontSize: '0.85rem',
                letterSpacing: '0.3px',
                transition: 'background 0.15s',
              }}
              onMouseOver={(e) => e.currentTarget.style.background = 'rgba(56,189,248,0.16)'}
              onMouseOut={(e) => e.currentTarget.style.background = 'rgba(56,189,248,0.08)'}
              title="Per-holding technical signals, trade plans, sector concentration"
            >
              Technical Alerts →
            </Link>
          </div>

          {/* X-Ray attention strip — which holdings need a look, and why */}
          {xray?.summary?.flagged > 0 && (
            <div title={xray.scoring} style={{
              display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap',
              padding: '0.7rem 1rem', marginBottom: '1.25rem', borderRadius: '8px',
              border: '1px solid rgba(251,191,36,0.35)', fontSize: '0.85rem',
            }}>
              <span style={{ fontWeight: 700, color: '#fbbf24' }}>
                ⚠ {xray.summary.flagged} of {xray.summary.total} holdings need attention
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {xray.summary.worstThree.map(w => `${w.symbol} (${w.score})`).join(' · ')}
                {' — sort by X-Ray or hover the badges for details'}
              </span>
            </div>
          )}

          {/* Portfolio Summary Stats */}
          {(() => {
            const todaysReturn = (holdings || []).reduce((sum, h) => {
              const dayChange = h.day_change !== undefined ? h.day_change : (h.last_price - (h.close_price || h.last_price));
              return sum + (dayChange * (h.quantity || 0));
            }, 0);
            const todaysReturnPct = currentVal ? ((todaysReturn / (currentVal - todaysReturn)) * 100) : 0;

            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid var(--accent)' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Invested</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`₹${totalInv.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid var(--accent)' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Holdings</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {(holdings || []).length}
                  </span>
                  <span className="label" style={{ fontSize: '0.8rem', marginTop: '0.25rem', opacity: 0.7 }}>stocks</span>
                </div>

                {/* Total Current Value */}
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid var(--text-primary)' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Current Value</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`₹${currentVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                </div>

                {/* Total Returns */}
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: `3px solid ${pl >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Returns</span>
                  <span className={`value ${pl >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`${pl >= 0 ? '+' : ''}₹${pl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                  <span className={`label ${pl >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    {priv(`(${plPercentage}%)`)}
                  </span>
                </div>

                {/* Today's Returns */}
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: `3px solid ${todaysReturn >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Today's Returns</span>
                  <span className={`value ${todaysReturn >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`${todaysReturn >= 0 ? '+' : ''}₹${todaysReturn.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                  <span className={`label ${todaysReturn >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    {priv(`(${todaysReturnPct.toFixed(2)}%)`)}
                  </span>
                </div>
              </div>
            );
          })()}
          {filteredAndSortedHoldings.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="interactive-table">
                <thead>
                  <tr>
                    <th onClick={() => handleSort('tradingsymbol')} style={{cursor: 'pointer'}}>Instrument <SortIcon field="tradingsymbol"/></th>
                    <th onClick={() => handleSort('xrayScore')} style={{cursor: 'pointer'}} title={xray?.scoring || 'Attention score from red flags, volatility, institutional and signal checks'}>X-Ray <SortIcon field="xrayScore"/></th>
                    <th onClick={() => handleSort('average_price')} style={{cursor: 'pointer'}}>Avg. Cost <SortIcon field="average_price"/></th>
                    <th onClick={() => handleSort('last_price')} style={{cursor: 'pointer'}}>LTP <SortIcon field="last_price"/></th>
                    <th onClick={() => handleSort('pe')} style={{cursor: 'pointer'}}>P/E <SortIcon field="pe"/></th>
                    <th onClick={() => handleSort('targetMean')} style={{cursor: 'pointer'}}>Target <SortIcon field="targetMean"/></th>
                    <th onClick={() => handleSort('quantity')} style={{cursor: 'pointer'}}>Qty. <SortIcon field="quantity"/></th>
                    <th onClick={() => handleSort('investment')} style={{cursor: 'pointer'}}>Invested <SortIcon field="investment"/></th>
                    <th onClick={() => handleSort('currentValue')} style={{cursor: 'pointer'}}>Cur. Value <SortIcon field="currentValue"/></th>
                    <th onClick={() => handleSort('itemPLPercent')} style={{cursor: 'pointer'}}>Net Chg. <SortIcon field="itemPLPercent"/></th>
                    <th onClick={() => handleSort('itemPL')} style={{cursor: 'pointer'}}>P&L <SortIcon field="itemPL"/></th>
                    <th onClick={() => handleSort('dayChangePct')} style={{cursor: 'pointer'}}>Day Chg. <SortIcon field="dayChangePct"/></th>
                    <th onClick={() => handleSort('allocation')} style={{cursor: 'pointer'}}>Allocation <SortIcon field="allocation"/></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedHoldings.map((item, index) => (
                    <tr key={index} onClick={() => navigate(`/instrument/${item.instrument_token}?symbol=${encodeURIComponent(item.tradingsymbol)}`)} style={{cursor: 'pointer'}}>
                      <td>
                        <strong>{item.tradingsymbol}</strong>
                        {companyNames[item.tradingsymbol] && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.1rem', fontWeight: 400, lineHeight: 1.3 }}>
                            {companyNames[item.tradingsymbol]}
                          </div>
                        )}
                      </td>
                      <td>{xray ? <XrayBadges badges={item.xrayBadges} /> : <span style={{ color: 'var(--text-secondary)', opacity: 0.4, fontSize: '0.7rem' }}>…</span>}</td>
                      <td>₹{Number(item.average_price).toFixed(2)}</td>
                      <td>₹{item.last_price}</td>
                      <td>{fundamentals[item.tradingsymbol]?.pe != null ? fundamentals[item.tradingsymbol].pe.toFixed(1) : '—'}</td>
                      <td>
                        {(() => {
                          const f = fundamentals[item.tradingsymbol];
                          if (!f || f.targetMean == null) return '—';
                          const cur = f.currentPrice ?? item.last_price;
                          const up = cur ? ((f.targetMean - cur) / cur) * 100 : null;
                          return <>
                            ₹{f.targetMean.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            {up != null && <span className={up >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.72rem', marginLeft: '0.3rem' }}>{up >= 0 ? '+' : ''}{up.toFixed(0)}%</span>}
                          </>;
                        })()}
                      </td>
                      <td>{item.displayQuantity}</td>
                      <td>{priv(`₹${item.investment.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}</td>
                      <td>{priv(`₹${item.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>{item.itemPLPercent.toFixed(2)}%</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>
                        {priv(`${item.itemPL > 0 ? '+' : ''}${item.itemPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                      </td>
                      <td className={item.dayChange >= 0 ? 'positive' : 'negative'}>
                        {item.dayChange >= 0 ? '+' : ''}{item.dayChange.toFixed(2)} ({item.dayChangePct.toFixed(2)}%)
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem' }}>
                          <div style={{ width: '48px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(item.allocation, 100)}%`, height: '100%', background: 'var(--accent)' }} />
                          </div>
                          <span style={{ minWidth: '46px', textAlign: 'right' }}>{item.allocation.toFixed(2)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No equity holdings found matching your search.</p>
          )}
        </section>
      ) : (
        <section className="glass-panel animate-in">
          <h2 style={{ marginBottom: '1.5rem' }}>Mutual Fund Holdings</h2>

          {/* MF Summary Stats */}
          {(() => {
            const mfTotalInv = (mfHoldings || []).reduce((sum, h) => sum + (h.average_price * h.quantity), 0);
            const mfCurrentVal = (mfHoldings || []).reduce((sum, h) => sum + (h.last_price * h.quantity), 0);
            const mfPL = mfCurrentVal - mfTotalInv;
            const mfPLPct = mfTotalInv ? ((mfPL / mfTotalInv) * 100).toFixed(2) : 0;

            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid var(--accent)' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Invested</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`₹${mfTotalInv.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid #a29bfe' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Current Value</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`₹${mfCurrentVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: `3px solid ${mfPL >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Returns</span>
                  <span className={`value ${mfPL >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {priv(`${mfPL >= 0 ? '+' : ''}₹${mfPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                  </span>
                  <span className={`label ${mfPL >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    {priv(`(${mfPLPct}%)`)}
                  </span>
                </div>
              </div>
            );
          })()}
          {filteredAndSortedMFs.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="interactive-table">
                <thead>
                  <tr>
                    <th onClick={() => handleSort('tradingsymbol')} style={{cursor: 'pointer'}}>Fund <SortIcon field="tradingsymbol"/></th>
                    <th onClick={() => handleSort('average_price')} style={{cursor: 'pointer'}}>Avg. Cost <SortIcon field="average_price"/></th>
                    <th onClick={() => handleSort('last_price')} style={{cursor: 'pointer'}}>NAV (LTP) <SortIcon field="last_price"/></th>
                    <th onClick={() => handleSort('quantity')} style={{cursor: 'pointer'}}>Qty. <SortIcon field="quantity"/></th>
                    <th onClick={() => handleSort('investment')} style={{cursor: 'pointer'}}>Invested <SortIcon field="investment"/></th>
                    <th onClick={() => handleSort('currentValue')} style={{cursor: 'pointer'}}>Cur. Value <SortIcon field="currentValue"/></th>
                    <th onClick={() => handleSort('itemPLPercent')} style={{cursor: 'pointer'}}>Net Chg. <SortIcon field="itemPLPercent"/></th>
                    <th onClick={() => handleSort('itemPL')} style={{cursor: 'pointer'}}>P&L <SortIcon field="itemPL"/></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedMFs.map((item, index) => (
                    <tr key={index}>
                      <td>
                        <strong>{item.fund || item.tradingsymbol}</strong>
                        <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{item.tradingsymbol}</div>
                      </td>
                      <td>₹{Number(item.average_price).toFixed(2)}</td>
                      <td>₹{item.last_price}</td>
                      <td>{item.displayQuantity}</td>
                      <td>{priv(`₹${item.investment.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}</td>
                      <td>{priv(`₹${item.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>{item.itemPLPercent.toFixed(2)}%</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>
                        {priv(`${item.itemPL > 0 ? '+' : ''}${item.itemPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No mutual fund holdings found matching your search.</p>
          )}
        </section>
      )}
    </div>
  )
}

export default Portfolio
