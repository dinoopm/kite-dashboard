import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'

function Portfolio() {
  const [profile, setProfile] = useState(null)
  const [holdings, setHoldings] = useState(null)
  const [mfHoldings, setMfHoldings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortField, setSortField] = useState('tradingsymbol')
  const [sortDirection, setSortDirection] = useState('asc')
  const [activeTab, setActiveTab] = useState('equity')
  
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

  const filteredAndSortedHoldings = (holdings || [])
    .filter(item => item.tradingsymbol.toLowerCase().includes(searchTerm.toLowerCase()))
    .map(item => {
      const q = (item.quantity || 0) + (item.t1_quantity || 0);
      const currentValue = q * item.last_price;
      const investment = q * item.average_price;
      const itemPL = item.pnl !== undefined ? item.pnl : (currentValue - investment);
      const itemPLPercent = investment ? (itemPL / investment) * 100 : 0;
      const dayChange = item.day_change !== undefined ? item.day_change : (item.last_price - (item.close_price || item.last_price));
      const dayChangePct = item.day_change_percentage !== undefined ? item.day_change_percentage : (item.close_price ? (dayChange / item.close_price) * 100 : 0);
      const allocation = currentVal ? (currentValue / currentVal) * 100 : 0;
      return { ...item, displayQuantity: q, currentValue, investment, itemPL, itemPLPercent, dayChange, dayChangePct, allocation };
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
                    ₹{totalInv.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
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
                    ₹{currentVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                </div>

                {/* Total Returns */}
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: `3px solid ${pl >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Returns</span>
                  <span className={`value ${pl >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {pl >= 0 ? '+' : ''}₹{pl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                  <span className={`label ${pl >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    ({plPercentage}%)
                  </span>
                </div>

                {/* Today's Returns */}
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: `3px solid ${todaysReturn >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Today's Returns</span>
                  <span className={`value ${todaysReturn >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {todaysReturn >= 0 ? '+' : ''}₹{todaysReturn.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                  <span className={`label ${todaysReturn >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    ({todaysReturnPct.toFixed(2)}%)
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
                    <th onClick={() => handleSort('average_price')} style={{cursor: 'pointer'}}>Avg. Cost <SortIcon field="average_price"/></th>
                    <th onClick={() => handleSort('last_price')} style={{cursor: 'pointer'}}>LTP <SortIcon field="last_price"/></th>
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
                      <td><strong>{item.tradingsymbol}</strong></td>
                      <td>₹{Number(item.average_price).toFixed(2)}</td>
                      <td>₹{item.last_price}</td>
                      <td>{item.displayQuantity}</td>
                      <td>₹{item.investment.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td>₹{item.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>{item.itemPLPercent.toFixed(2)}%</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>
                        {item.itemPL > 0 ? '+' : ''}{item.itemPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
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
                    ₹{mfTotalInv.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid #a29bfe' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Current Value</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    ₹{mfCurrentVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: `3px solid ${mfPL >= 0 ? 'var(--success)' : 'var(--danger)'}` }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Returns</span>
                  <span className={`value ${mfPL >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    {mfPL >= 0 ? '+' : ''}₹{mfPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                  <span className={`label ${mfPL >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    ({mfPLPct}%)
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
                      <td>₹{item.investment.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td>₹{item.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>{item.itemPLPercent.toFixed(2)}%</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>
                        {item.itemPL > 0 ? '+' : ''}{item.itemPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
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
