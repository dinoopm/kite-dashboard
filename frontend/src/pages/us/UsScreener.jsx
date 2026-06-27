import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchWithAbort } from '../../hooks/useFetchWithAbort';
import UsSearch from '../../components/UsSearch';

const POLL_MS = 1500;
const NUMBER_OPS = [{ v: 'gt', label: '>' }, { v: 'gte', label: '≥' }, { v: 'lt', label: '<' }, { v: 'lte', label: '≤' }];
const ENUM_OPS = [{ v: 'is', label: 'is' }, { v: 'isnot', label: 'is not' }];
const BASKETS_KEY = 'us-screener-baskets-v1';
const SCREENS_KEY = 'us-screener-screens-v1';

// Built-in preset screens (scope defaults to S&P 500; switch the universe after
// loading to apply the same conditions to Nasdaq 100, a sector, or a basket).
const PRESET_SCREENS = [
  { id: 'p-near52w', name: 'Near 52w High', scope: { type: 'sp500' }, conditions: [{ field: 'dist52wHigh', op: 'gte', value: -5 }, { field: 'supertrend', op: 'is', value: 'BULL' }] },
  { id: 'p-volbreak', name: 'Volume Breakout', scope: { type: 'sp500' }, conditions: [{ field: 'breakout20d', op: 'is', value: 'YES' }, { field: 'volSurge', op: 'gte', value: 1.5 }, { field: 'rsi14', op: 'gt', value: 55 }] },
  { id: 'p-overbought', name: 'Overbought / Trim', scope: { type: 'sp500' }, conditions: [{ field: 'rsi14', op: 'gte', value: 75 }, { field: 'supertrend', op: 'is', value: 'BULL' }] },
  { id: 'p-oversold', name: 'Oversold Bounce (in uptrend)', scope: { type: 'sp500' }, conditions: [{ field: 'rsi14', op: 'lt', value: 35 }, { field: 'pctVsSma200', op: 'gt', value: 0 }] },
  { id: 'p-strong', name: 'Strong Uptrend (ST+ADX)', scope: { type: 'sp500' }, conditions: [{ field: 'supertrend', op: 'is', value: 'BULL' }, { field: 'smaCross', op: 'is', value: 'GOLDEN' }, { field: 'adx14', op: 'gte', value: 25 }, { field: 'pctVsSma200', op: 'gt', value: 0 }] },
  { id: 'p-approaching', name: 'Approaching Breakout', scope: { type: 'sp500' }, conditions: [{ field: 'signal1050', op: 'is', value: 'BUY' }, { field: 'signal1050Age', op: 'lte', value: 15 }, { field: 'dist20dHigh', op: 'gte', value: -3 }] },
  { id: 'p-buy20d', name: 'BUY + 20d Breakout', scope: { type: 'sp500' }, conditions: [{ field: 'signal1050', op: 'is', value: 'BUY' }, { field: 'breakout20d', op: 'is', value: 'YES' }] },
];

const RESULT_COLUMNS = [
  { key: 'price', label: 'Price $' },
  { key: 'change1D', label: '1D %', pct: true },
  { key: 'rsi14', label: 'RSI' },
  { key: 'adx14', label: 'ADX' },
  { key: 'volSurge', label: 'Vol×' },
  { key: 'signal1050', label: '10/50 Signal' },
  { key: 'supertrend', label: 'SuperTrend' },
  { key: 'pctVsSma200', label: 'vs 200SMA %', pct: true },
  { key: 'ret1M', label: '1M %', pct: true },
  { key: 'ret1Y', label: '1Y %', pct: true },
  { key: 'dist52wHigh', label: '52wH %', pct: true },
];

const inputStyle = { background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', padding: '0.4rem 0.6rem', fontSize: '0.85rem' };
const pnlClass = (v) => (v == null ? '' : v > 0 ? 'positive' : v < 0 ? 'negative' : '');
const loadLS = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };
const uid = () => Math.random().toString(36).slice(2, 9);

function ConditionRow({ cond, fields, onChange, onRemove }) {
  const field = fields.find(f => f.key === cond.field);
  const ops = field?.type === 'enum' ? ENUM_OPS : NUMBER_OPS;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={cond.field} onChange={e => { const f = fields.find(x => x.key === e.target.value); onChange({ field: f.key, op: f.type === 'enum' ? 'is' : 'gt', value: f.type === 'enum' ? f.enumValues[0] : 0 }); }} style={{ ...inputStyle, cursor: 'pointer', minWidth: '200px' }}>
        {Object.entries(fields.reduce((g, f) => { (g[f.group] = g[f.group] || []).push(f); return g; }, {})).map(([group, fs]) => (
          <optgroup key={group} label={group}>{fs.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>
        ))}
      </select>
      <select value={cond.op} onChange={e => onChange({ ...cond, op: e.target.value })} style={{ ...inputStyle, cursor: 'pointer', width: '80px' }}>
        {ops.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      {field?.type === 'enum' ? (
        <select value={cond.value} onChange={e => onChange({ ...cond, value: e.target.value })} style={{ ...inputStyle, cursor: 'pointer', width: '110px' }}>
          {field.enumValues.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : (
        <input type="number" step="any" value={cond.value} onChange={e => onChange({ ...cond, value: e.target.value === '' ? '' : +e.target.value })} style={{ ...inputStyle, width: '110px' }} />
      )}
      <button onClick={onRemove} title="Remove" style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '0.3rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
    </div>
  );
}

function ResultsTable({ matches }) {
  const [sort, setSort] = useState({ key: 'change1D', dir: 'desc' });
  const sorted = useMemo(() => {
    const arr = [...(matches || [])];
    arr.sort((a, b) => {
      const av = sort.key === 'symbol' ? a.symbol : a.values[sort.key];
      const bv = sort.key === 'symbol' ? b.symbol : b.values[sort.key];
      if (av == null) return 1; if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [matches, sort]);
  const header = (key, label, align = 'right') => (
    <th key={key} onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))} style={{ cursor: 'pointer', textAlign: align, fontSize: '0.75rem', whiteSpace: 'nowrap', userSelect: 'none', padding: '0.5rem 0.9rem' }}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const td = { textAlign: 'right', fontSize: '0.85rem', padding: '0.55rem 0.9rem', whiteSpace: 'nowrap' };
  return (
    <div className="glass-panel" style={{ padding: '0.5rem 0.5rem 1rem', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{header('symbol', 'Symbol', 'left')}{RESULT_COLUMNS.map(c => header(c.key, c.label))}</tr></thead>
        <tbody>
          {sorted.map(m => (
            <tr key={m.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={{ ...td, textAlign: 'left' }}>
                <Link to={`/us/${encodeURIComponent(m.symbol)}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>{m.symbol}</Link>
                {m.name && m.name !== m.symbol && <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>}
              </td>
              {RESULT_COLUMNS.map(c => {
                const v = m.values[c.key];
                if (v == null) return <td key={c.key} style={td}>—</td>;
                if (c.key === 'supertrend' || c.key === 'signal1050') {
                  const color = (v === 'BULL' || v === 'BUY') ? '#22c55e' : (v === 'BEAR' || v === 'SELL') ? '#ef4444' : 'var(--text-secondary)';
                  return <td key={c.key} style={{ ...td, color, fontWeight: 600 }}>{v}</td>;
                }
                return <td key={c.key} style={td} className={c.pct ? pnlClass(v) : ''}>{typeof v === 'number' ? `${c.pct && v > 0 ? '+' : ''}${v}${c.pct ? '%' : ''}` : v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function UsScreener() {
  const [fields, setFields] = useState(null);
  const [sectors, setSectors] = useState([]);
  const [conditions, setConditions] = useState([{ field: 'rsi14', op: 'gt', value: 60 }, { field: 'pctVsSma200', op: 'gt', value: 0 }]);
  const [scopeType, setScopeType] = useState('sp500'); // sp500 | nasdaq100 | sector | basket
  const [sector, setSector] = useState('');
  const [baskets, setBaskets] = useState(() => loadLS(BASKETS_KEY, []));
  const [activeBasketId, setActiveBasketId] = useState(() => loadLS(BASKETS_KEY, [])[0]?.id || null);
  const [newBasketName, setNewBasketName] = useState('');
  const [screens, setScreens] = useState(() => loadLS(SCREENS_KEY, []));
  const [screenName, setScreenName] = useState('');
  const [jobStatus, setJobStatus] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    (async () => {
      try { const r = await (await fetchWithAbort('/api/us/screener/fields')).json(); setFields(r.fields); } catch { /* */ }
      try { const s = await (await fetchWithAbort('/api/us/screener/sectors')).json(); if (Array.isArray(s)) { setSectors(s); setSector(k => k || s[0] || ''); } } catch { /* */ }
    })();
  }, []);
  useEffect(() => { saveLS(BASKETS_KEY, baskets); }, [baskets]);
  useEffect(() => { saveLS(SCREENS_KEY, screens); }, [screens]);
  useEffect(() => () => clearTimeout(pollRef.current), []);

  const activeBasket = baskets.find(b => b.id === activeBasketId) || null;

  const buildScope = useCallback(() => {
    if (scopeType === 'sector') return { type: 'sector', sector };
    if (scopeType === 'basket') return { type: 'custom', name: activeBasket?.name, symbols: activeBasket?.symbols || [] };
    return { type: scopeType };
  }, [scopeType, sector, activeBasket]);

  const poll = useCallback(async (jobId) => {
    try {
      const res = await (await fetchWithAbort(`/api/us/screener/run/${jobId}`)).json();
      setProgress(res.progress);
      if (res.status === 'running') { pollRef.current = setTimeout(() => poll(jobId), POLL_MS); }
      else if (res.status === 'done') { setResult(res.result); setJobStatus('done'); }
      else { setError(res.error || 'Screen failed'); setJobStatus('error'); }
    } catch (e) { setError(e.message); setJobStatus('error'); }
  }, []);

  const run = useCallback(async () => {
    if (scopeType === 'sector' && !sector) return setError('Pick a sector');
    if (scopeType === 'basket' && (!activeBasket || activeBasket.symbols.length === 0)) return setError('Pick a non-empty basket');
    setError(null); setResult(null); setProgress(null); setJobStatus('running');
    try {
      const res = await fetchWithAbort('/api/us/screener/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: buildScope(), conditions }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Run failed');
      poll(data.jobId);
    } catch (e) { setError(e.message); setJobStatus('error'); }
  }, [scopeType, sector, activeBasket, conditions, buildScope, poll]);

  // Basket ops
  const createBasket = () => {
    const name = newBasketName.trim(); if (!name) return;
    const b = { id: uid(), name, symbols: [] };
    setBaskets(bs => [...bs, b]); setActiveBasketId(b.id); setNewBasketName('');
  };
  const addToBasket = (row) => setBaskets(bs => bs.map(b => b.id === activeBasketId && !b.symbols.includes(row.symbol) ? { ...b, symbols: [...b.symbols, row.symbol] } : b));
  const removeFromBasket = (sym) => setBaskets(bs => bs.map(b => b.id === activeBasketId ? { ...b, symbols: b.symbols.filter(s => s !== sym) } : b));
  const deleteBasket = (id) => { setBaskets(bs => bs.filter(b => b.id !== id)); if (activeBasketId === id) setActiveBasketId(null); };

  // Saved screens (localStorage)
  const saveScreen = () => {
    const name = screenName.trim(); if (!name) return;
    setScreens(ss => [...ss, { id: uid(), name, scope: buildScope(), conditions }]); setScreenName('');
  };
  const loadScreen = (s) => {
    setConditions(s.conditions || []);
    const sc = s.scope || {};
    if (sc.type === 'sector') { setScopeType('sector'); setSector(sc.sector || ''); }
    else if (sc.type === 'custom') {
      let b = baskets.find(x => x.name === sc.name && JSON.stringify(x.symbols) === JSON.stringify(sc.symbols));
      if (!b) { b = { id: uid(), name: sc.name || 'Loaded basket', symbols: sc.symbols || [] }; setBaskets(bs => [...bs, b]); }
      setActiveBasketId(b.id); setScopeType('basket');
    } else setScopeType(sc.type || 'sp500');
  };
  const deleteScreen = (id) => setScreens(ss => ss.filter(s => s.id !== id));

  const running = jobStatus === 'running';
  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const OP_SYM = { gt: '>', gte: '≥', lt: '<', lte: '≤', is: 'is', isnot: 'is not' };
  const describe = (c) => { const f = fields?.find(x => x.key === c.field); return `${f ? f.label : c.field} ${OP_SYM[c.op] || c.op} ${c.value}`; };
  const scopeLabel = (sc) => sc?.type === 'sector' ? sc.sector : sc?.type === 'custom' ? `basket: ${sc.name}` : sc?.type === 'nasdaq100' ? 'Nasdaq 100' : 'S&P 500';
  const scopeBtn = (type, label) => (
    <button onClick={() => { setScopeType(type); setError(null); }} style={{
      background: scopeType === type ? 'var(--accent)' : 'transparent', color: scopeType === type ? '#0f172a' : 'var(--text-secondary)',
      border: `1px solid ${scopeType === type ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '8px', padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem', fontWeight: scopeType === type ? 700 : 500,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h1 style={{ marginBottom: '0.25rem' }}>US Screener</h1>
        <Link to="/us" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '0.85rem' }}>← US Markets</Link>
      </div>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Scan the S&amp;P 500, Nasdaq 100, a GICS sector, or your own basket against indicator conditions — all conditions must match. Same engine as the India screener (RSI, ADX, SuperTrend, SMA/EMA, volume).
      </p>

      {/* Universe */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Universe</span>
        {scopeBtn('sp500', 'S&P 500')}
        {scopeBtn('nasdaq100', 'Nasdaq 100')}
        {scopeBtn('sector', 'Sector')}
        {scopeBtn('basket', 'My Basket')}
        {scopeType === 'sector' && (
          <select value={sector} onChange={e => setSector(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {sectors.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {scopeType === 'basket' && (
          <select value={activeBasketId || ''} onChange={e => setActiveBasketId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer', minWidth: '160px' }}>
            <option value="">— select basket —</option>
            {baskets.map(b => <option key={b.id} value={b.id}>{b.name} ({b.symbols.length})</option>)}
          </select>
        )}
      </div>

      {/* Basket manager */}
      {scopeType === 'basket' && (
        <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input placeholder="New basket name…" value={newBasketName} onChange={e => setNewBasketName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createBasket()} style={{ ...inputStyle, width: '200px' }} />
            <button onClick={createBasket} disabled={!newBasketName.trim()} style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '8px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.82rem' }}>+ Create basket</button>
            {activeBasket && <button onClick={() => deleteBasket(activeBasket.id)} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '8px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.82rem' }}>Delete “{activeBasket.name}”</button>}
          </div>
          {activeBasket ? (
            <>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Add to <strong style={{ color: 'var(--text-primary)' }}>{activeBasket.name}</strong>:</span>
                <UsSearch width="240px" placeholder="Search to add…" onSelect={addToBasket} />
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {activeBasket.symbols.length === 0 && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No symbols yet — search above to add.</span>}
                {activeBasket.symbols.map(s => (
                  <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'rgba(56,189,248,0.1)', border: '1px solid var(--border)', borderRadius: '999px', padding: '0.2rem 0.6rem', fontSize: '0.8rem', fontWeight: 600 }}>
                    {s}<span onClick={() => removeFromBasket(s)} style={{ cursor: 'pointer', color: 'var(--text-secondary)' }} title="Remove">✕</span>
                  </span>
                ))}
              </div>
            </>
          ) : <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Create or select a basket to add US stocks.</span>}
        </div>
      )}

      {/* Conditions */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Conditions (all must match)</span>
        {!fields ? <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Loading fields…</p> : (
          <>
            {conditions.map((c, i) => (
              <ConditionRow key={i} cond={c} fields={fields} onChange={next => setConditions(cs => cs.map((x, j) => j === i ? next : x))} onRemove={() => setConditions(cs => cs.filter((_, j) => j !== i))} />
            ))}
            <div>
              <button onClick={() => setConditions(cs => [...cs, { field: 'rsi14', op: 'lt', value: 30 }])} disabled={conditions.length >= 12} style={{ background: 'transparent', border: '1px dashed var(--border)', color: 'var(--accent)', borderRadius: '8px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.82rem' }}>+ Add condition</button>
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button onClick={run} disabled={running || !fields || conditions.length === 0} style={{ background: running ? 'rgba(56,189,248,0.3)' : 'var(--accent)', color: '#0f172a', border: 'none', borderRadius: '8px', padding: '0.55rem 1.5rem', fontWeight: 700, cursor: running ? 'wait' : 'pointer', fontSize: '0.9rem' }}>
          {running ? 'Scanning…' : 'Run screen'}
        </button>
        <input placeholder="Screen name…" value={screenName} onChange={e => setScreenName(e.target.value)} style={{ ...inputStyle, width: '180px' }} />
        <button onClick={saveScreen} disabled={!screenName.trim()} style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '8px', padding: '0.5rem 1.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>Save screen</button>
      </div>

      {running && (
        <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            <span>{progress?.total ? `Scanning ${progress.loaded}/${progress.total}` : 'Resolving universe…'}{progress?.symbol ? ` — ${progress.symbol}` : ''}</span>
            <span>{pct}%</span>
          </div>
          <div style={{ height: '8px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: '4px', transition: 'width 0.4s' }} />
          </div>
        </div>
      )}

      {error && <p className="negative">{error}</p>}

      {result && jobStatus === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0 }}>
            {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 400, marginLeft: '0.75rem' }}>of {result.scanned} scanned in {result.label}{result.notReady?.length ? ` · ${result.notReady.length} unavailable` : ''}</span>
          </h2>
          {result.matches.length > 0 ? <ResultsTable matches={result.matches} /> : <p style={{ color: 'var(--text-secondary)' }}>No stocks matched all conditions.</p>}
        </div>
      )}

      {/* Preset screens */}
      <h3 style={{ margin: '0.5rem 0 0.75rem' }}>Preset screens</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {PRESET_SCREENS.map(s => (
          <div key={s.id} className="glass-panel" style={{ padding: '0.7rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <strong style={{ minWidth: '180px' }}>{s.name}</strong>
            <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.1rem 0.4rem' }}>Preset</span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flex: 1 }}>{(s.conditions || []).map(describe).join('  AND  ')}</span>
            <button onClick={() => loadScreen(s)} style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '6px', padding: '0.25rem 0.8rem', cursor: 'pointer', fontSize: '0.78rem' }}>Load</button>
          </div>
        ))}
      </div>

      {/* Saved screens */}
      <h3 style={{ margin: '0.5rem 0 0.75rem' }}>Saved screens</h3>
      {screens.length === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No saved screens yet.</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {screens.map(s => (
            <div key={s.id} className="glass-panel" style={{ padding: '0.7rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <strong style={{ minWidth: '140px' }}>{s.name}</strong>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flex: 1 }}>
                {scopeLabel(s.scope)}{' · '}{(s.conditions || []).map(describe).join('  AND  ')}
              </span>
              <button onClick={() => loadScreen(s)} style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '6px', padding: '0.25rem 0.8rem', cursor: 'pointer', fontSize: '0.78rem' }}>Load</button>
              <button onClick={() => deleteScreen(s.id)} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '0.25rem 0.8rem', cursor: 'pointer', fontSize: '0.78rem' }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
