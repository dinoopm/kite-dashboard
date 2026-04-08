import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'

function Portfolio() {
  const [profile, setProfile] = useState(null)
  const [holdings, setHoldings] = useState(null)
  const [mfHoldings, setMfHoldings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [loginMsg, setLoginMsg] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortField, setSortField] = useState('tradingsymbol')
  const [sortDirection, setSortDirection] = useState('asc')
  const [activeTab, setActiveTab] = useState('equity')
  
  const navigate = useNavigate()

  const fetchData = async () => {
    try {
      setLoading(true)
      const profileRes = await fetch('http://localhost:3001/api/profile')
      const profileData = await profileRes.json()
      
      if (profileData.isError || profileData.error) {
        setNeedsAuth(true)
        return;
      }
      
      const holdingsRes = await fetch('http://localhost:3001/api/holdings')
      const holdingsData = await holdingsRes.json()

      if (profileData?.content?.[0]?.text) {
        try { setProfile(JSON.parse(profileData.content[0].text)) } catch(e) {}
      }

      if (holdingsData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(holdingsData.content[0].text) 
          setHoldings(parsed.data ? parsed.data : parsed)
        } catch(e) {}
      }

      const mfRes = await fetch('http://localhost:3001/api/mf-holdings')
      const mfData = await mfRes.json()

      if (mfData?.content?.[0]?.text) {
        try { 
          const parsed = JSON.parse(mfData.content[0].text) 
          setMfHoldings(parsed.data ? parsed.data : parsed)
        } catch(e) {}
      }
    } catch (err) {
      console.error(err)
      setError('Failed to fetch data from backend.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const handleLogin = async () => {
    try {
      setLoading(true)
      const res = await fetch('http://localhost:3001/api/login', { method: 'POST' })
      const data = await res.json()
      if (data?.content?.[0]?.text) {
        setLoginMsg(data.content[0].text)
      }
    } catch (err) {
      setError('Login request failed')
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="loader"></div>
  if (error) return <div className="dashboard-layout"><div className="glass-panel"><p className="negative">{error}</p><button onClick={() => window.location.reload()} style={{padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem'}}>Retry</button></div></div>
  
  if (needsAuth) {
    return (
      <div className="dashboard-layout" style={{ maxWidth: '600px' }}>
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
          <h2>Authentication Required</h2>
          <p>Please authorize the local dashboard to access your Kite data.</p>
          {!loginMsg ? (
            <button onClick={handleLogin} style={{padding: '0.75rem 1.5rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginTop: '1rem', transition: 'all 0.2s'}}>
              Login to Kite
            </button>
          ) : (
            <div style={{ textAlign: 'left', background: 'var(--bg-dark)', padding: '1rem', borderRadius: '8px', marginTop: '1.5rem', lineHeight: '1.5' }}>
              <ReactMarkdown components={{ a: ({node, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{loginMsg}</ReactMarkdown>
              <br />
              <button onClick={() => { setNeedsAuth(false); fetchData(); }} style={{padding: '0.5rem 1rem', background: 'var(--success)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem'}}>
                I have logged in
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const getTotalInvestment = () => {
    if (!holdings || !Array.isArray(holdings)) return 0;
    return holdings.reduce((sum, h) => sum + (h.average_price * h.quantity), 0);
  };

  const getCurrentValue = () => {
    if (!holdings || !Array.isArray(holdings)) return 0;
    return holdings.reduce((sum, h) => sum + (h.last_price * h.quantity), 0);
  };

  const totalInv = getTotalInvestment();
  const currentVal = getCurrentValue();
  const pl = currentVal - totalInv;
  const plPercentage = totalInv ? ((pl / totalInv) * 100).toFixed(2) : 0;

  const filteredAndSortedHoldings = (holdings || [])
    .filter(item => item.tradingsymbol.toLowerCase().includes(searchTerm.toLowerCase()))
    .map(item => {
      const currentValue = item.quantity * item.last_price;
      const investment = item.quantity * item.average_price;
      const itemPL = currentValue - investment;
      const itemPLPercent = investment ? (itemPL / investment) * 100 : 0;
      const dayChange = item.last_price - (item.close_price || item.last_price);
      const dayChangePct = item.close_price ? (dayChange / item.close_price) * 100 : 0;
      return { ...item, currentValue, investment, itemPL, itemPLPercent, dayChange, dayChangePct };
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
        const currentValue = item.quantity * item.last_price;
        const investment = item.quantity * item.average_price;
        const itemPL = currentValue - investment;
        const itemPLPercent = investment ? (itemPL / investment) * 100 : 0;
        return { ...item, currentValue, investment, itemPL, itemPLPercent };
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
      </div>

      {activeTab === 'equity' ? (
        <section className="glass-panel animate-in">
          <h2 style={{ marginBottom: '1.5rem' }}>Equity Holdings</h2>

          {/* Portfolio Summary Stats */}
          {(() => {
            const todaysReturn = (holdings || []).reduce((sum, h) => {
              const closePrice = h.close_price || h.last_price;
              return sum + ((h.last_price - closePrice) * h.quantity);
            }, 0);
            const todaysReturnPct = currentVal ? ((todaysReturn / (currentVal - todaysReturn)) * 100) : 0;

            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                {/* Total Invested */}
                <div className="glass-panel stat-card" style={{ padding: '1.25rem', borderLeft: '3px solid var(--accent)' }}>
                  <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>Total Invested</span>
                  <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700' }}>
                    ₹{totalInv.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
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
                    <th onClick={() => handleSort('quantity')} style={{cursor: 'pointer'}}>Qty. <SortIcon field="quantity"/></th>
                    <th onClick={() => handleSort('average_price')} style={{cursor: 'pointer'}}>Avg. Cost <SortIcon field="average_price"/></th>
                    <th onClick={() => handleSort('last_price')} style={{cursor: 'pointer'}}>LTP <SortIcon field="last_price"/></th>
                    <th onClick={() => handleSort('dayChange')} style={{cursor: 'pointer'}}>Day Chg. <SortIcon field="dayChange"/></th>
                    <th onClick={() => handleSort('investment')} style={{cursor: 'pointer'}}>Invested <SortIcon field="investment"/></th>
                    <th onClick={() => handleSort('currentValue')} style={{cursor: 'pointer'}}>Cur. Value <SortIcon field="currentValue"/></th>
                    <th onClick={() => handleSort('itemPL')} style={{cursor: 'pointer'}}>P&L <SortIcon field="itemPL"/></th>
                    <th onClick={() => handleSort('itemPLPercent')} style={{cursor: 'pointer'}}>Net Chg. <SortIcon field="itemPLPercent"/></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedHoldings.map((item, index) => (
                    <tr key={index} onClick={() => navigate(`/instrument/${item.instrument_token}?symbol=${item.tradingsymbol}`)} style={{cursor: 'pointer'}}>
                      <td><strong>{item.tradingsymbol}</strong></td>
                      <td>{item.quantity}</td>
                      <td>₹{item.average_price}</td>
                      <td>₹{item.last_price}</td>
                      <td className={item.dayChange >= 0 ? 'positive' : 'negative'}>
                        {item.dayChange >= 0 ? '+' : ''}{item.dayChange.toFixed(2)} ({item.dayChangePct.toFixed(2)}%)
                      </td>
                      <td>₹{item.investment.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td>₹{item.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>
                        {item.itemPL > 0 ? '+' : ''}{item.itemPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>{item.itemPLPercent.toFixed(2)}%</td>
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
                    <th onClick={() => handleSort('quantity')} style={{cursor: 'pointer'}}>Qty. <SortIcon field="quantity"/></th>
                    <th onClick={() => handleSort('average_price')} style={{cursor: 'pointer'}}>Avg. Cost <SortIcon field="average_price"/></th>
                    <th onClick={() => handleSort('last_price')} style={{cursor: 'pointer'}}>NAV (LTP) <SortIcon field="last_price"/></th>
                    <th onClick={() => handleSort('investment')} style={{cursor: 'pointer'}}>Invested <SortIcon field="investment"/></th>
                    <th onClick={() => handleSort('currentValue')} style={{cursor: 'pointer'}}>Cur. Value <SortIcon field="currentValue"/></th>
                    <th onClick={() => handleSort('itemPL')} style={{cursor: 'pointer'}}>P&L <SortIcon field="itemPL"/></th>
                    <th onClick={() => handleSort('itemPLPercent')} style={{cursor: 'pointer'}}>Net Chg. <SortIcon field="itemPLPercent"/></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedMFs.map((item, index) => (
                    <tr key={index}>
                      <td>
                        <strong>{item.fund || item.tradingsymbol}</strong>
                        <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{item.tradingsymbol}</div>
                      </td>
                      <td>{item.quantity}</td>
                      <td>₹{item.average_price}</td>
                      <td>₹{item.last_price}</td>
                      <td>₹{item.investment.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td>₹{item.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>
                        {item.itemPL > 0 ? '+' : ''}{item.itemPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <td className={item.itemPL >= 0 ? 'positive' : 'negative'}>{item.itemPLPercent.toFixed(2)}%</td>
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
