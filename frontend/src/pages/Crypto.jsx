import { useState, useEffect, useRef, useMemo } from 'react'
import { createChart } from 'lightweight-charts'

// ─── Crypto ──────────────────────────────────────────────────────────────────
//
// Prices and volume from Alpaca, and deliberately nothing else.
//
// No signals, no track-record badges, no "20-day breakout". Everything this app
// scores is counted in SESSIONS against a trading calendar, and crypto has no
// sessions — a daily bar here closes at an arbitrary UTC boundary on a market
// that never shuts. An indicator lifted across would be a different object
// wearing the same name, and its NSE-derived record would say nothing about it.
//
// The volume caveat is stronger still: equities have a consolidated tape, so
// the sip feed sees the whole market. Crypto has none, so these bars are what
// crossed Alpaca's venue — not what traded. Both limits are printed on the page
// rather than left for someone to discover.

const UP = '#2dd4bf'
const DOWN = '#fb7185'
const BG = '#131722'
const GRID = '#1e2230'

const fmtPrice = (v) => {
  if (v == null) return '—'
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (v >= 1) return `$${v.toFixed(2)}`
  return `$${v.toPrecision(4)}`
}
const fmtVol = (v) => {
  if (v == null) return '—'
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(2)
}
const pct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
const tone = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? UP : DOWN)

// The ranges, and the bar size each one implies. They are not independent
// choices: five years of 5-minute candles is unreadable and one day of daily
// candles is a single bar, so the server picks the timeframe from the range and
// the label here just says which it used.
const RANGES = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y']
const INTRADAY = new Set(['1D', '1W', '1M', '3M'])

/** Candles plus volume. No overlays — see the note at the top of this file. */
function CryptoChart({ slug, range }) {
  const box = useRef(null)
  const [bars, setBars] = useState([])
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const ctl = new AbortController()
    fetch(`/api/crypto/bars/${slug}?range=${range}`, { signal: ctl.signal })
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return }
        setBars(j.bars || [])
        setMeta(j)
      })
      .catch(e => e.name !== 'AbortError' && setError(e.message))
    return () => ctl.abort()
  }, [slug, range])

  useEffect(() => {
    if (!box.current || !bars.length) return
    const el = box.current
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { color: BG }, textColor: '#c3cce0', fontSize: 12 },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: GRID, scaleMargins: { top: 0.1, bottom: 0.25 } },
      // Crypto trades every day, so the axis must not hide weekends — that
      // option exists for markets that close, and this one does not.
      timeScale: { borderColor: GRID, timeVisible: INTRADAY.has(range), secondsVisible: false },
    })
    const candles = chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    })
    const toTime = (iso) => Math.floor(Date.parse(iso) / 1000)
    candles.setData(bars.map(b => ({
      time: toTime(b.date), open: b.open, high: b.high, low: b.low, close: b.close,
    })))
    const vol = chart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false,
    })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    vol.setData(bars.map(b => ({
      time: toTime(b.date), value: b.volume,
      color: b.close >= b.open ? 'rgba(45,212,191,0.45)' : 'rgba(251,113,133,0.45)',
    })))
    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [bars, range])

  if (error) return <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>
  if (!bars.length) return <div className="loader" style={{ margin: '3rem auto' }} />

  // Alpaca's history does not reach back equally far for every pair. Saying so
  // beats drawing fourteen months under a 5Y label as though that were all
  // there ever was.
  const short = meta?.firstBar && meta?.requestedFrom
    && Date.parse(meta.firstBar) - Date.parse(meta.requestedFrom) > 30 * 86400000

  return (
    <>
      <div ref={box} style={{ width: '100%', height: short ? 'calc(100% - 20px)' : '100%' }} />
      {short && (
        <div style={{ fontSize: '0.66rem', color: '#fcd34d', paddingTop: '3px' }}>
          History starts {new Date(meta.firstBar).toISOString().slice(0, 10)} — Alpaca has less
          than {meta.range} for this pair.
        </div>
      )}
    </>
  )
}

export default function Crypto() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState('BTC-USD')
  const [range, setRange] = useState('1Y')
  const [sort, setSort] = useState({ key: 'volume', dir: 'desc' })

  useEffect(() => {
    let on = true
    fetch('/api/crypto/snapshots')
      .then(r => r.json())
      .then(j => { if (!on) return; j.error ? setError(j.error) : setData(j) })
      .catch(e => on && setError(e.message))
    return () => { on = false }
  }, [])

  const rows = useMemo(() => {
    const list = [...(data?.rows || [])]
    return list.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [data, sort])

  const cols = [
    { key: 'name', label: 'Pair', align: 'left' },
    { key: 'close', label: 'Price' },
    { key: 'changePct', label: 'Change', hint: 'Bar over bar, not a rolling 24 hours — a daily bar closes at a UTC boundary on a market that never does.' },
    { key: 'volume', label: 'Volume', hint: "What crossed Alpaca's venue. Crypto has no consolidated tape, so this is not total market volume." },
    { key: 'trades', label: 'Trades' },
  ]
  const current = rows.find(r => r.slug === selected) || rows[0]

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Crypto</h1>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Prices and volume from Alpaca — {rows.length || '…'} USD pairs
        </span>
      </div>

      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
      {!data && !error && <div className="loader" style={{ margin: '3rem auto' }} />}

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1fr) 2fr', gap: '1rem', alignItems: 'start' }}>
          <section className="glass-panel" style={{ padding: '0.75rem 1rem' }}>
            <table className="interactive-table" style={{ width: '100%', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  {cols.map(c => (
                    <th key={c.key} title={c.hint}
                      onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                      style={{ textAlign: c.align || 'right', cursor: 'pointer', padding: '0.35rem 0.4rem', fontSize: '0.68rem', whiteSpace: 'nowrap', color: sort.key === c.key ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {c.label}{sort.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.slug} onClick={() => setSelected(r.slug)}
                    style={{ cursor: 'pointer', background: r.slug === selected ? 'rgba(56,189,248,0.10)' : 'transparent' }}>
                    <td style={{ padding: '0.4rem' }}>
                      {r.name}
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}> {r.pair}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{fmtPrice(r.close)}</td>
                    <td style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: tone(r.changePct) }}>{pct(r.changePct)}</td>
                    <td style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{fmtVol(r.volume)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{r.trades == null ? '—' : r.trades.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="glass-panel" style={{ padding: '1rem 1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1rem' }}>{current?.name} <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>{current?.pair}</span></h2>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                  {fmtPrice(current?.close)} · <span style={{ color: tone(current?.changePct) }}>{pct(current?.changePct)}</span> bar over bar
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {RANGES.map(v => (
                  <button key={v} onClick={() => setRange(v)} style={{
                    padding: '0.28rem 0.55rem', borderRadius: '4px', fontSize: '0.72rem', cursor: 'pointer',
                    border: `1px solid ${range === v ? 'var(--accent)' : 'var(--border)'}`,
                    background: range === v ? 'rgba(56,189,248,0.12)' : 'transparent',
                    color: range === v ? 'var(--accent)' : 'var(--text-secondary)',
                    fontWeight: range === v ? 700 : 400,
                  }}>{v}</button>
                ))}
              </div>
            </div>
            <div style={{ height: '460px' }}>
              {current && <CryptoChart key={`${current.slug}:${range}`} slug={current.slug} range={range} />}
            </div>
          </section>
        </div>
      )}

      {data && (
        <section className="glass-panel" style={{ padding: '0.9rem 1.25rem', marginTop: '1rem', fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--text-primary)' }}>What this is, and is not</strong>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
            <li>{data.caveat}</li>
            <li>{data.barNote}</li>
            <li><strong>No signals here on purpose.</strong> Every indicator elsewhere in this app counts
              horizons in trading sessions and is scored against NSE. Crypto has no sessions, so those
              rules would be different objects wearing the same names, with a track record that says
              nothing about them.</li>
          </ul>
        </section>
      )}
    </div>
  )
}
