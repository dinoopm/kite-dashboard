import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import Dashboard from './pages/Dashboard'
import Portfolio from './pages/Portfolio'
import Instrument from './pages/Instrument'
import Alerts from './pages/Alerts'
import SectorIndices from './pages/SectorIndices'
import SectorDetail from './pages/SectorDetail'
import Basket from './pages/Basket'
import ThemeDetail from './pages/ThemeDetail'
import VirtualPortfolio from './pages/VirtualPortfolio'
import VirtualPortfolioDetail from './pages/VirtualPortfolioDetail'
import VixIndex from './pages/VixIndex'
import Screener from './pages/Screener'
import UsIndices from './pages/us/UsIndices'
import UsMacro from './pages/us/UsMacro'
import UsSectorDetail from './pages/us/UsSectorDetail'
import UsInstrument from './pages/us/UsInstrument'
import UsScreener from './pages/us/UsScreener'
import UsBasket from './pages/us/UsBasket'
import UsBasketDetail from './pages/us/UsBasketDetail'
import UsVirtualPortfolio from './pages/us/UsVirtualPortfolio'
import UsVirtualPortfolioDetail from './pages/us/UsVirtualPortfolioDetail'
import Chat from './pages/Chat'
import Journal from './pages/Journal'
import Briefing from './pages/Briefing'
import FiiDii from './pages/marketData/FiiDii'
import LargeDeals from './pages/marketData/LargeDeals'
import Week52HighLow from './pages/marketData/Week52HighLow'
import TopGainersLosers from './pages/marketData/TopGainersLosers'
import VolumeGainers from './pages/marketData/VolumeGainers'
import SurveillanceStocks from './pages/marketData/SurveillanceStocks'
import StockPicks from './pages/marketData/StockPicks'
import MacroEconomics from './pages/marketData/MacroEconomics'
import EventsCalendar from './pages/marketData/EventsCalendar'
import OilTracker from './pages/marketData/OilTracker'
import Navbar from './components/Navbar'

// Pull the authorize link out of the MCP login tool's reply. It arrives both as
// a markdown link and as a bare URL; take whichever matches first and strip the
// trailing ")" markdown leaves behind.
const extractAuthUrl = (text) => {
  if (!text) return null
  const md = text.match(/\]\((https?:\/\/[^\s)]+)\)/)
  if (md) return md[1]
  const bare = text.match(/https?:\/\/[^\s)\]]+/)
  return bare ? bare[0] : null
}

function App() {
  const [authState, setAuthState] = useState('loading') // 'loading' | 'authenticated' | 'unauthenticated'
  const [loginMsg, setLoginMsg] = useState(null)
  const [authUrl, setAuthUrl] = useState(null)
  const [awaitingAuth, setAwaitingAuth] = useState(false)
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  const checkAuth = useCallback(async () => {
    try {
      setAuthState('loading')
      // Fail fast if backend is completely frozen or stuck after 10s
      const res = await fetch('/api/profile', { signal: AbortSignal.timeout(10000) })
      const data = await res.json()

      if (!res.ok || data.isError || data.error) {
        const errText = JSON.stringify(data).toLowerCase()
        if (errText.includes('429') || errText.includes('rate') || errText.includes('too many')) {
          // Rate limited — retry after a short delay
          setTimeout(() => checkAuth(), 3000)
          return
        }
        setAuthState('unauthenticated')
      } else {
        setAuthState('authenticated')
      }
    } catch (err) {
      setAuthState('unauthenticated')
    }
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const handleLogin = async () => {
    try {
      setIsLoggingIn(true)
      const res = await fetch('/api/login', { method: 'POST' })
      const data = await res.json()
      if (data?.content?.[0]?.text) {
        const text = data.content[0].text
        const url = extractAuthUrl(text)
        // The MCP login tool answers with prose written for an AI client
        // ("display this warning", "let me know and I'll continue") plus the
        // risk disclaimer Kite already shows on its own authorize page. None
        // of that belongs in a human UI — keep the URL, drop the script. Fall
        // back to rendering the raw text only if the URL can't be parsed.
        if (url) setAuthUrl(url)
        else setLoginMsg(text)
      } else if (data?.error) {
        setLoginMsg("❌ **Connection issue:** " + data.error + "\n\nThe system attempted to auto-reconnect. Please click **Login to Kite** again.")
      }
    } catch (err) {
      // ignore
    } finally {
      setIsLoggingIn(false)
    }
  }

  const handleLoginComplete = () => {
    setLoginMsg(null)
    setAuthUrl(null)
    setAwaitingAuth(false)
    checkAuth()
  }

  // Once the user opens the Kite tab, poll quietly so the dashboard lets them
  // in the moment authorization lands — no "I have logged in" round trip.
  useEffect(() => {
    if (!awaitingAuth) return
    let cancelled = false
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/profile', { signal: AbortSignal.timeout(8000) })
        const data = await res.json()
        if (cancelled || !res.ok || data.isError || data.error) return
        setAwaitingAuth(false)
        setAuthUrl(null)
        setAuthState('authenticated')
      } catch {
        // keep polling — the Kite tab is probably still open
      }
    }, 2500)
    return () => { cancelled = true; clearInterval(id) }
  }, [awaitingAuth])

  const handleDisconnect = async (e) => {
    if (e) e.preventDefault();
    setAuthState('unauthenticated');
    setLoginMsg(null);
    try {
      await fetch('/api/disconnect', { method: 'POST' });
    } catch (err) {
      console.error('Failed to disconnect', err);
    }
  }

  if (authState === 'loading') {
    return <div className="loader"></div>
  }

  if (authState === 'unauthenticated') {
    return (
      <div style={{ maxWidth: '1600px', width: '95%', margin: '0 auto', padding: '2rem 1rem' }}>
        <div className="dashboard-layout" style={{ maxWidth: '600px' }}>
          <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
            <h2 style={{ color: 'var(--accent)', marginBottom: '0.5rem' }}>Kite Analytics</h2>
            <h3>Connect your Kite account</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              {authUrl
                ? 'Approve access in the Kite tab. This dashboard unlocks automatically.'
                : 'Authorize the local dashboard to read your Kite data.'}
            </p>

            {authUrl ? (
              <>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setAwaitingAuth(true)}
                  style={{
                    display: 'inline-block', padding: '0.75rem 1.5rem', background: 'var(--accent)',
                    color: '#fff', borderRadius: '8px', fontWeight: 'bold', textDecoration: 'none',
                    marginTop: '1rem',
                  }}
                >
                  {awaitingAuth ? 'Reopen Kite authorization ↗' : 'Continue to Kite ↗'}
                </a>
                {awaitingAuth && (
                  <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    <div className="loader" style={{ width: '14px', height: '14px', borderWidth: '2px', margin: 0 }} />
                    Waiting for authorization…
                  </div>
                )}
                <div style={{ marginTop: '1.25rem' }}>
                  <button
                    onClick={handleLoginComplete}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    Already approved? Check now
                  </button>
                </div>
              </>
            ) : !loginMsg ? (
              <button
                onClick={handleLogin}
                disabled={isLoggingIn}
                style={{
                  padding: '0.75rem 1.5rem',
                  background: isLoggingIn ? 'var(--bg-light)' : 'var(--accent)',
                  color: isLoggingIn ? 'var(--text-secondary)' : '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: isLoggingIn ? 'wait' : 'pointer',
                  fontWeight: 'bold',
                  marginTop: '1rem',
                  transition: 'all 0.2s'
                }}
              >
                {isLoggingIn ? 'Generating Link…' : 'Login to Kite'}
              </button>
            ) : (
              <div style={{ textAlign: 'left', background: 'var(--bg-dark)', padding: '1rem', borderRadius: '8px', marginTop: '1.5rem', lineHeight: '1.5' }}>
                <ReactMarkdown components={{ a: ({node, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{loginMsg}</ReactMarkdown>
                <br />
                <button
                  onClick={handleLoginComplete}
                  style={{padding: '0.5rem 1rem', background: 'var(--success)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem'}}
                >
                  I have logged in
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <div style={{ maxWidth: '1600px', width: '95%', margin: '0 auto', padding: '2rem 1rem' }}>
        <Navbar onDisconnect={handleDisconnect} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/journal" element={<Journal />} />
          <Route path="/briefing" element={<Briefing />} />
          <Route path="/indices" element={<SectorIndices />} />
          <Route path="/vix" element={<VixIndex />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/market-data/stock-picks" element={<StockPicks />} />
          <Route path="/market-data/fii-dii" element={<FiiDii />} />
          <Route path="/market-data/large-deals" element={<LargeDeals />} />
          <Route path="/market-data/52wk-high-low" element={<Week52HighLow />} />
          <Route path="/market-data/top-gainers-losers" element={<TopGainersLosers />} />
          <Route path="/market-data/volume-gainers" element={<VolumeGainers />} />
          <Route path="/market-data/surveillance" element={<SurveillanceStocks />} />
          <Route path="/market-data/macro" element={<MacroEconomics />} />
          <Route path="/market-data/events" element={<EventsCalendar />} />
          <Route path="/market-data/oil" element={<OilTracker />} />
          <Route path="/instrument/:token" element={<Instrument />} />
          <Route path="/sector/:sectorId" element={<SectorDetail />} />
          <Route path="/basket" element={<Basket />} />
          <Route path="/basket/:themeId" element={<ThemeDetail />} />
          <Route path="/virtual" element={<VirtualPortfolio />} />
          <Route path="/virtual/:portfolioId" element={<VirtualPortfolioDetail />} />
          <Route path="/screener" element={<Screener />} />
          <Route path="/us" element={<UsIndices />} />
          <Route path="/us/macro" element={<UsMacro />} />
          <Route path="/us/screener" element={<UsScreener />} />
          <Route path="/us/basket" element={<UsBasket />} />
          <Route path="/us/basket/:id" element={<UsBasketDetail />} />
          <Route path="/us/virtual" element={<UsVirtualPortfolio />} />
          <Route path="/us/virtual/:id" element={<UsVirtualPortfolioDetail />} />
          <Route path="/us/sector/:sectorId" element={<UsSectorDetail />} />
          <Route path="/us/:symbol" element={<UsInstrument />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
