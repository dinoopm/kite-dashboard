import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts'

const fmtINR = (v) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

// Strategy equity vs buy-and-hold, mark-to-market daily.
export default function EquityCurveChart({ equityCurve, buyHoldCurve, height = 320 }) {
  if (!equityCurve || equityCurve.length === 0) return null
  const bhMap = new Map((buyHoldCurve || []).map(pt => [pt.date, pt.equity]))
  const data = equityCurve.map(pt => ({
    date: pt.date,
    strategy: pt.equity,
    buyHold: bhMap.get(pt.date) ?? null,
    drawdownPct: pt.drawdownPct,
  }))

  return (
    <div className="glass-panel" style={{ padding: '1rem', minWidth: 0 }}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
          <XAxis dataKey="date" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} minTickGap={60} />
          <YAxis
            tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
            tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
            domain={['auto', 'auto']}
            width={52}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.8rem' }}
            labelStyle={{ color: 'var(--text-secondary)' }}
            formatter={(value, name, item) => {
              if (name === 'Strategy') {
                const dd = item?.payload?.drawdownPct
                return [`${fmtINR(value)}${dd != null && dd < 0 ? ` (dd ${dd}%)` : ''}`, name]
              }
              return [fmtINR(value), name]
            }}
          />
          <Legend wrapperStyle={{ fontSize: '0.78rem' }} />
          <Line type="monotone" dataKey="strategy" name="Strategy" stroke="#38bdf8" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="buyHold" name="Buy & Hold" stroke="#94a3b8" dot={false} strokeWidth={1.5} strokeDasharray="6 4" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
