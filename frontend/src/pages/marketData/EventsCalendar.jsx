import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'

// Upcoming corporate events: the scraped NSE board-meeting calendar (results,
// dividends, fund raising) merged with user-added events (/api/user-events).
// Events on stocks currently held get highlighted and can be filtered to.
const GREY = 'var(--text-secondary)'

const fmtDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
const daysUntil = (iso) => Math.ceil((new Date(iso + 'T00:00:00') - new Date()) / 86400000)

// Measured base rates around past macro events (/api/macro-study): how much
// the S&P, US 10Y, NIFTY (next session) and FII flows actually moved —
// against an all-days baseline, so the numbers mean something.
function MacroStudy() {
  const [s, setS] = useState(null)
  useEffect(() => {
    let on = true
    fetch('/api/macro-study').then(r => (r.ok ? r.json() : null)).then(j => { if (on && j && !j.error) setS(j) }).catch(() => { })
    return () => { on = false }
  }, [])
  if (!s) return null
  return (
    <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)', marginBottom: '0.6rem' }}>
        Event-reaction study <span style={{ color: GREY, fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· measured base rates, {s.baseline.window}</span>
      </div>
      {s.types.map(t => {
        // Plain-English headline, derived from the same numbers shown below.
        const stormier = Math.round((t.spx.avgAbs / s.baseline.spxAvgAbs - 1) * 100)
        const pd = t.niftyNext.pctDown
        const direction = pd == null ? null
          : pd >= 40 && pd <= 60 ? 'a coin flip'
          : pd > 60 ? `down ${Math.round(pd)}% of the time — leans red`
          : `up ${Math.round(100 - pd)}% of the time — leans green`
        return (
          <div key={t.type} style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>{t.type} <span style={{ color: GREY, fontWeight: 500, fontSize: '0.75rem' }}>{t.n} events, {t.from} → {t.to}</span></div>
            <div style={{ fontSize: '0.88rem', lineHeight: 1.6, marginTop: '0.25rem' }}>
              These days are <b style={{ color: stormier >= 20 ? '#fbbf24' : 'var(--text-primary)' }}>~{stormier}% stormier</b> than a normal US session
              {direction && <>, and India's next-morning direction is <b>{direction}</b></>}.
              {' '}<span style={{ color: GREY }}>Expect bigger candles, don't predict the color: enter smaller and give stops more room around these dates.</span>
            </div>
            <div style={{ fontSize: '0.74rem', color: GREY, lineHeight: 1.6, marginTop: '0.3rem' }}>
              The numbers: S&P 500 moved ±{t.spx.avgAbs}% on these days vs ±{s.baseline.spxAvgAbs}% normally, crossing 1% on {Math.round(t.spx.pctOver1)}% of them;
              the US 10Y yield swung ±{t.us10y.avgAbsBps} bps. NIFTY's next session: ±{t.niftyNext.avgAbs}% vs ±{s.baseline.niftyAvgAbs}% normally, closing lower {Math.round(pd)}% of the time
              {t.fiiNext.n >= 10 ? <> · FII next-session avg {t.fiiNext.avgNetCr >= 0 ? '+' : '−'}₹{Math.abs(t.fiiNext.avgNetCr).toLocaleString('en-IN')} cr</> : null}.
            </div>
          </div>
        )
      })}
      <p style={{ margin: '0.4rem 0 0', fontSize: '0.68rem', color: GREY, fontStyle: 'italic', lineHeight: 1.5 }}>
        {s.notes[0]} CPI/jobs/GDP base rates appear here as their dates accumulate in the seeded calendar.
      </p>
    </div>
  )
}

export default function EventsCalendar() {
  const [market, setMarket] = useState('in') // 'in' | 'us'
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [onlyHeld, setOnlyHeld] = useState(false)
  const [form, setForm] = useState({ symbol: '', date: '', title: '', notes: '' })
  const [formMsg, setFormMsg] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [reactions, setReactions] = useState({}) // symbol -> earnings-reaction stats (US, "mine" rows only)

  const load = (mkt = market) => {
    setData(null); setError(null)
    if (mkt === 'macro') {
      // US macro calendar (FOMC/CPI/jobs/GDP) — no symbols, so no links/highlights.
      fetch('/api/macro-events')
        .then(r => r.json())
        .then(j => {
          if (j.error) return setError(j.error)
          setData({
            events: j.events.map(e => ({
              symbol: null,
              company: null,
              purpose: e.title,
              detail: e.detail,
              date: e.date,
              held: false,
              custom: false,
              macro: true,
            })),
            source: j.source,
          })
        })
        .catch(e => setError(e.message))
    } else if (mkt === 'us') {
      // US earnings calendar (S&P 500 + Nasdaq 100) — mapped into the same
      // event shape; "held" = present in a US basket or virtual portfolio.
      fetch('/api/us/earnings-calendar')
        .then(r => r.json())
        .then(j => {
          if (j.error) return setError(j.error)
          setData({
            events: j.events.map(e => ({
              symbol: e.symbol,
              company: e.name,
              purpose: `Earnings · ${e.session}${e.estimated ? ' (estimated)' : ''}`,
              detail: null,
              date: e.date,
              held: e.mine,
              custom: false,
              us: true,
            })),
            source: j.source,
          })
        })
        .catch(e => setError(e.message))
    } else {
      fetch('/api/events')
        .then(r => r.json())
        .then(j => (j.error ? setError(j.error) : setData(j)))
        .catch(e => setError(e.message))
    }
  }
  useEffect(() => { load(market) }, [market]) // eslint-disable-line react-hooks/exhaustive-deps

  // Per-stock earnings-reaction stats — only for symbols in your baskets/
  // portfolios (a handful of calls), so held rows say "typically ±X%".
  useEffect(() => {
    if (market !== 'us' || !data?.events) return
    let on = true
    const mine = [...new Set(data.events.filter(e => e.held).map(e => e.symbol))].slice(0, 12)
    for (const sym of mine) {
      if (reactions[sym]) continue
      fetch(`/api/us/earnings-reaction/${encodeURIComponent(sym)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(j => { if (on && j && !j.error) setReactions(prev => ({ ...prev, [sym]: j })) })
        .catch(() => { })
    }
    return () => { on = false }
  }, [market, data]) // eslint-disable-line react-hooks/exhaustive-deps

  const addEvent = async (e) => {
    e.preventDefault()
    setFormMsg(null)
    try {
      const r = await fetch('/api/user-events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setForm({ symbol: '', date: '', title: '', notes: '' })
      setFormMsg('Added ✓')
      setShowModal(false)
      load()
    } catch (err) { setFormMsg(err.message) }
  }

  const removeEvent = async (id) => {
    await fetch(`/api/user-events/${id}`, { method: 'DELETE' }).catch(() => { })
    load()
  }

  const grouped = useMemo(() => {
    const rows = (data?.events || []).filter(e => market === 'macro' || !onlyHeld || e.held)
    const byDate = new Map()
    for (const e of rows) {
      if (!byDate.has(e.date)) byDate.set(e.date, [])
      byDate.get(e.date).push(e)
    }
    return [...byDate.entries()]
  }, [data, onlyHeld, market])

  const heldCount = (data?.events || []).filter(e => e.held).length

  const input = { padding: '0.45rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-dark)', color: 'var(--text-primary)', fontSize: '0.82rem', colorScheme: 'dark' }

  if (error) return <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--danger)' }}>Events unavailable: {error}</div>
  if (!data) return <div className="loader" />

  return (
    <div className="dashboard-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Corporate Events</h1>
          <p style={{ margin: '0.3rem 0 0', color: GREY, fontSize: '0.85rem' }}>
            {data.events.length} upcoming · {market === 'us'
              ? 'US earnings dates across S&P 500 + Nasdaq 100 (Yahoo)'
              : market === 'macro'
                ? 'FOMC · CPI · jobs · GDP — official Fed/BLS/BEA schedules, seeded annually'
                : 'NSE board-meeting calendar (results, dividends, fund raising) + your own events'}
            {heldCount > 0 && <> · <b style={{ color: 'var(--accent)' }}>{heldCount} on your {market === 'us' ? 'baskets/portfolios' : 'holdings'}</b></>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          {[['in', 'India'], ['us', 'US Earnings'], ['macro', 'US Macro']].map(([key, label]) => (
            <button key={key} onClick={() => setMarket(key)} style={{
              padding: '0.35rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700,
              border: `1px solid ${market === key ? 'var(--accent)' : 'var(--border)'}`,
              background: market === key ? 'rgba(56,189,248,0.12)' : 'transparent',
              color: market === key ? 'var(--accent)' : GREY,
            }}>{label}</button>
          ))}
          {market !== 'macro' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.85rem', color: GREY, cursor: 'pointer', marginLeft: '0.6rem' }}>
              <input type="checkbox" checked={onlyHeld} onChange={e => setOnlyHeld(e.target.checked)} />
              only mine
            </label>
          )}
        </div>
      </div>

      {/* Add your own event (India calendar only for now) */}
      {market === 'in' && (
        <div style={{ marginBottom: '1.5rem' }}>
          <button onClick={() => { setFormMsg(null); setShowModal(true) }} style={{ padding: '0.5rem 1.1rem', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem', border: '1px solid rgba(56,189,248,0.25)', background: 'rgba(56,189,248,0.08)', color: 'var(--accent)' }}>+ Add event</button>
        </div>
      )}

      {showModal && (
        <div onClick={() => setShowModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.7)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <form onClick={e => e.stopPropagation()} onSubmit={addEvent} className="glass-panel" style={{ padding: '2.25rem', width: '100%', maxWidth: '44rem', display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Add event</span>
              <button type="button" onClick={() => setShowModal(false)} style={{ background: 'transparent', border: 'none', color: GREY, cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>
              Symbol
              <input style={{ ...input, textTransform: 'none' }} placeholder="e.g. RELIANCE" value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} required />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>
              Date
              <input style={input} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>
              Title
              <input style={{ ...input, textTransform: 'none' }} placeholder="e.g. AGM, lock-in expiry" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREY }}>
              Notes (optional)
              <textarea rows={3} style={{ ...input, textTransform: 'none', resize: 'vertical', fontFamily: 'inherit' }} placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </label>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '0.3rem' }}>
              <button type="submit" style={{ padding: '0.5rem 1.2rem', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem', border: '1px solid rgba(56,189,248,0.25)', background: 'rgba(56,189,248,0.08)', color: 'var(--accent)' }}>+ Add</button>
              <button type="button" onClick={() => setShowModal(false)} style={{ padding: '0.5rem 1.1rem', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem', border: '1px solid var(--border)', background: 'transparent', color: GREY }}>Cancel</button>
              {formMsg && formMsg !== 'Added ✓' && <span style={{ fontSize: '0.78rem', color: '#f87171' }}>{formMsg}</span>}
            </div>
          </form>
        </div>
      )}

      {market === 'macro' && <MacroStudy />}

      {grouped.length === 0 && (
        <p style={{ color: GREY }}>{onlyHeld ? 'No upcoming events on your holdings.' : 'No upcoming events.'}</p>
      )}

      {grouped.map(([date, events]) => {
        const d = daysUntil(date)
        return (
          <div key={date} style={{ marginBottom: '1.4rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '0.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>{fmtDay(date)}</h3>
              <span style={{ fontSize: '0.72rem', color: d <= 2 ? '#fbbf24' : GREY }}>{d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}</span>
            </div>
            <div className="glass-panel" style={{ padding: '0.3rem 0' }}>
              {events.map((e, i) => (
                <div key={`${e.symbol}-${e.purpose}-${i}`} style={{
                  display: 'flex', gap: '0.8rem', alignItems: 'baseline', padding: '0.55rem 1rem',
                  borderBottom: i < events.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                  borderLeft: e.held ? '3px solid var(--accent)' : '3px solid transparent',
                  background: e.held ? 'rgba(56,189,248,0.05)' : 'transparent',
                }}>
                  {e.macro ? (
                    <span style={{ flex: '0 0 15rem', fontWeight: 700, fontSize: '0.85rem', color: '#fbbf24' }}>🇺🇸 {e.purpose}</span>
                  ) : (
                    <Link to={e.us ? `/us/${encodeURIComponent(e.symbol)}` : `/instrument/0?symbol=${encodeURIComponent(e.symbol)}`}
                      style={{ flex: '0 0 15rem', textDecoration: 'none', overflow: 'hidden' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-primary)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.symbol}</span>
                      {e.company && <span style={{ fontSize: '0.68rem', color: GREY, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.company}>{e.company}</span>}
                    </Link>
                  )}
                  {e.held && <span style={{ flexShrink: 0, fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--accent)', border: '1px solid rgba(56,189,248,0.35)', borderRadius: '4px', padding: '0.05rem 0.3rem' }}>holding</span>}
                  {e.custom && <span style={{ flexShrink: 0, fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.4)', borderRadius: '4px', padding: '0.05rem 0.3rem' }}>yours</span>}
                  {!e.macro && <span style={{ fontSize: '0.85rem' }}>{e.purpose}</span>}
                  {e.us && e.held && reactions[e.symbol] && (
                    <span title={`Last ${reactions[e.symbol].n} reports · best +${reactions[e.symbol].best}% / worst ${reactions[e.symbol].worst}% · ${reactions[e.symbol].pctUp}% up`}
                      style={{ flexShrink: 0, fontSize: '0.68rem', fontWeight: 700, color: reactions[e.symbol].avgAbsPct >= 5 ? '#fbbf24' : GREY }}>
                      typically ±{reactions[e.symbol].avgAbsPct}%
                    </span>
                  )}
                  {e.detail && <span style={{ fontSize: '0.75rem', color: GREY, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.detail}>{e.detail}</span>}
                  {e.custom && (
                    <button onClick={() => removeEvent(e.id)} title="Delete this event"
                      style={{ marginLeft: 'auto', flexShrink: 0, background: 'transparent', border: 'none', color: GREY, cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
