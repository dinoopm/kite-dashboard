import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL || '';

// Virtual Portfolios dashboard — lists the user's paper ("virtual") portfolios.
// Create one here, then open it to add holdings (instrument + avg cost + qty) and
// see invested / current value / P&L / day change / allocation auto-calculated.
export default function VirtualPortfolio() {
  const [portfolios, setPortfolios] = useState(null);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null); // portfolio being renamed
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/portfolios`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load portfolios');
      setPortfolios(data.portfolios || []);
      setError(null);
    } catch (e) {
      setError(e.message);
      setPortfolios([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createPortfolio = async (e) => {
    e?.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/portfolios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      setNewName('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const deletePortfolio = async (id, name) => {
    if (!window.confirm(`Delete portfolio "${name}"? This removes all its holdings.`)) return;
    try {
      const res = await fetch(`${API}/api/portfolios/${id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Delete failed'); }
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const startEdit = (p) => { setEditingId(p.id); setDraft(p.name); };
  const cancelEdit = () => { setEditingId(null); setDraft(''); };

  const renamePortfolio = async (id) => {
    const name = draft.trim();
    if (!name) { cancelEdit(); return; }
    const current = portfolios.find(p => p.id === id);
    if (current && name === current.name) { cancelEdit(); return; }
    try {
      const res = await fetch(`${API}/api/portfolios/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setPortfolios(ps => (ps || []).map(p => (p.id === id ? { ...p, name } : p)));
      cancelEdit();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Virtual Portfolios</h1>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Build paper portfolios — enter instrument, average cost and quantity; invested, current value, P&amp;L,
            day change and allocation are calculated live from market prices.
          </span>
        </div>
        <form onSubmit={createPortfolio} style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New portfolio name…"
            maxLength={60}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.5rem 0.9rem', fontSize: '0.9rem', minWidth: '220px' }}
          />
          <button
            type="submit"
            disabled={!newName.trim() || creating}
            style={{ background: 'var(--accent)', color: '#04141f', border: 'none', borderRadius: '8px', padding: '0.5rem 1.1rem', fontWeight: 700, cursor: newName.trim() && !creating ? 'pointer' : 'not-allowed', opacity: newName.trim() && !creating ? 1 : 0.5 }}
          >
            {creating ? 'Creating…' : '+ Create'}
          </button>
        </form>
      </div>

      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', color: '#fca5a5', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {portfolios == null ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
      ) : portfolios.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No portfolios yet. Create your first virtual portfolio above.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
          {portfolios.map(p => {
            const isEditing = editingId === p.id;
            return (
            <div key={p.id} className="glass-panel" style={{ padding: '1.25rem', position: 'relative' }}>
              {isEditing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <input
                    autoFocus
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') renamePortfolio(p.id); if (e.key === 'Escape') cancelEdit(); }}
                    maxLength={60}
                    style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.45rem 0.7rem', fontSize: '1rem', fontWeight: 700 }}
                  />
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => renamePortfolio(p.id)} style={{ background: 'var(--accent)', color: '#04141f', border: 'none', borderRadius: '6px', padding: '0.35rem 0.9rem', fontWeight: 700, cursor: 'pointer', fontSize: '0.8rem' }}>Save</button>
                    <button onClick={cancelEdit} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.35rem 0.9rem', cursor: 'pointer', fontSize: '0.8rem' }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <Link to={`/virtual/${p.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.4rem', paddingRight: '3.2rem' }}>{p.name}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {p.holdingsCount} {p.holdingsCount === 1 ? 'holding' : 'holdings'}
                    </div>
                  </Link>
                  <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <button
                      onClick={() => startEdit(p)}
                      title="Rename portfolio"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1 }}
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => deletePortfolio(p.id, p.name)}
                      title="Delete portfolio"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  </div>
                </>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
