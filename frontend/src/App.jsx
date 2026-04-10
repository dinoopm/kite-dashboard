import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import Dashboard from './pages/Dashboard'
import Portfolio from './pages/Portfolio'
import Instrument from './pages/Instrument'
import Alerts from './pages/Alerts'
import Navbar from './components/Navbar'

function App() {
  const [authState, setAuthState] = useState('loading') // 'loading' | 'authenticated' | 'unauthenticated'
  const [loginMsg, setLoginMsg] = useState(null)
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  const checkAuth = useCallback(async () => {
    try {
      setAuthState('loading')
      // Fail fast if backend is completely frozen or stuck after 10s
      const res = await fetch('http://localhost:3001/api/profile', { signal: AbortSignal.timeout(10000) })
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
      const res = await fetch('http://localhost:3001/api/login', { method: 'POST' })
      const data = await res.json()
      if (data?.content?.[0]?.text) {
        setLoginMsg(data.content[0].text)
      } else if (data?.error) {
        setLoginMsg("❌ **Error generating login URL:** " + data.error + "\n\nPlease wait a few seconds and try again. If it persists, restart the backend server.")
      }
    } catch (err) {
      // ignore
    } finally {
      setIsLoggingIn(false)
    }
  }

  const handleLoginComplete = () => {
    setLoginMsg(null)
    checkAuth()
  }

  const handleDisconnect = async () => {
    if (window.confirm('Disconnect the kite dashboard? You will need to login again.')) {
      setAuthState('unauthenticated')
      setLoginMsg(null)
      try {
        await fetch('http://localhost:3001/api/disconnect', { method: 'POST' })
      } catch (err) {
        console.error('Failed to disconnect', err)
      }
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
            <h3>Authentication Required</h3>
            <p>Please authorize the local dashboard to access your Kite data.</p>
            {!loginMsg ? (
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
                {isLoggingIn ? 'Generating Link...' : 'Login to Kite'}
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
          <Route path="/instrument/:token" element={<Instrument />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
