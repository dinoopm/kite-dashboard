import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL || '';

// US thematic baskets — curate your own sets of US tickers (persisted in
// Supabase, shared with the US Screener's "My Basket" universe).
export default function UsBasket() {
  const [baskets, setBaskets] = useState(null);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/us/baskets`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load baskets');
      setBaskets(data.baskets || []);
      setError(null);
    } catch (e) { setError(e.message); setBaskets([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const createBasket = async (e) => {
    e?.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/us/baskets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      setNewName(''); await load();
    } catch (e) { setError(e.message); } finally { setCreating(false); }
  };
  const deleteBasket = async (id, name) => {
    if (!window.confirm(`Delete basket "${name}"?`)) return;
    try {
      const res = await fetch(`${API}/api/us/baskets/${id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      await load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>US Thematic Baskets</h1>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Curate your own themes of US stocks — each gets a performance table and an RRG vs the S&amp;P 500.
          </span>
        </div>
        <form onSubmit={createBasket} style={{ display: 'flex', gap: '0.5rem' }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New basket name…" maxLength={60}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.5rem 0.9rem', fontSize: '0.9rem', minWidth: '220px' }} />
          <button type="submit" disabled={!newName.trim() || creating}
            style={{ background: 'var(--accent)', color: '#04141f', border: 'none', borderRadius: '8px', padding: '0.5rem 1.1rem', fontWeight: 700, cursor: newName.trim() && !creating ? 'pointer' : 'not-allowed', opacity: newName.trim() && !creating ? 1 : 0.5 }}>
            {creating ? 'Creating…' : '+ Create'}
          </button>
        </form>
      </div>

      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', color: '#fca5a5', fontSize: '0.85rem' }}>{error}</div>
      )}

      {baskets == null ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
      ) : baskets.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No baskets yet. Create your first US basket above.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
          {baskets.map(b => (
            <div key={b.id} className="glass-panel" style={{ padding: '1.25rem', position: 'relative' }}>
              <Link to={`/us/basket/${b.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.4rem', paddingRight: '1.5rem' }}>{b.name}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {(b.symbols || []).length} {(b.symbols || []).length === 1 ? 'stock' : 'stocks'}
                </div>
              </Link>
              <button onClick={() => deleteBasket(b.id, b.name)} title="Delete basket"
                style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
