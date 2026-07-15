// Sector breadth analyser — presentational. Reads the object from
// computeSectorBreadth() and shows an overall verdict, a row of dimension tiles
// (advance/decline, new highs vs lows, RSI distribution, SMA20, SMA200), and the
// detailed above/below name lists. Pure presentation: no fetching, no state.
import { STRONG_MIN, MIXED_MIN } from '../lib/sectorBreadth';

const GREEN = '#10b981', AMBER = '#eab308', RED = '#ef4444';

// Zone color for a 0–100 breadth-style percentage (higher = greener).
const zone = (pct) => (pct >= 60 ? GREEN : pct >= 40 ? AMBER : RED);
const verdictColor = (score) => (score >= STRONG_MIN ? GREEN : score >= MIXED_MIN ? AMBER : RED);

const TIPS = {
  ad: 'How many of the sector’s stocks are up today vs down. Broad green = the whole sector is moving, not just a few names.',
  nhl: 'Stocks closing at a new multi-month high vs those below their 1-month high. More new highs = leadership broadening.',
  rsi: 'Distribution of 14-day RSI. Many overbought (≥70) = stretched/late; many oversold (≤30) = washed out.',
  sma20: 'Share of the sector trading above its own 20-day average — the short-term pulse.',
  sma200: 'Share trading above its 200-day average — the big-picture trend/regime.',
};

// One dimension tile: headline value (zone-colored) + a sub-line of raw counts.
function Tile({ label, value, valueColor, sub, tip }) {
  return (
    <div
      title={tip}
      style={{
        flex: '1 1 150px', minWidth: '150px', cursor: 'help',
        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px', padding: '0.7rem 0.9rem',
      }}
    >
      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label} ⓘ</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 800, color: valueColor, marginTop: '0.15rem' }}>{value}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>{sub}</div>
    </div>
  );
}

// SMA above/below detail card (moved here from the sector pages so both share it).
function MaBreadthCard({ title, subtitle, pct, aboveNames, belowNames }) {
  const color = zone(pct);
  const bg = pct >= 60 ? '#10b98118' : pct >= 40 ? '#eab30818' : '#ef444418';
  return (
    <div style={{ flex: '1 1 320px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '1rem 1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>{subtitle}</div>
        </div>
        <span style={{ fontSize: '1.4rem', fontWeight: 800, color, background: bg, padding: '0.2rem 0.6rem', borderRadius: '6px' }}>
          {Math.round(pct)}%
        </span>
      </div>
      <div style={{ height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', marginBottom: '1rem', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.round(pct)}%`, background: color, borderRadius: '3px', transition: 'width 0.6s ease' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: GREEN, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
            Above ({aboveNames.length})
          </div>
          {aboveNames.map(n => (
            <div key={n} style={{ fontSize: '0.72rem', color: 'var(--text-primary)', padding: '0.15rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n}</div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: RED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
            Below ({belowNames.length})
          </div>
          {belowNames.map(n => (
            <div key={n} style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', padding: '0.15rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SectorBreadthPanel({ breadth }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
        Sector Breadth
      </div>

      {!breadth ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading SMA data…</p>
      ) : (
        <>
          {/* Overall verdict */}
          {(() => {
            const { score, verdict, read } = breadth.composite;
            const c = verdictColor(score);
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.4rem', padding: '0.35rem 0.8rem', borderRadius: '999px', background: `${c}18`, border: `1px solid ${c}`, color: c }}>
                  <strong style={{ fontSize: '1.15rem', fontWeight: 800 }}>{score}</strong>
                  <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{verdict}</span>
                </span>
                <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{read}</span>
                <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>{breadth.loadedCount} stocks loaded</span>
              </div>
            );
          })()}

          {/* Dimension tiles */}
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
            {(() => {
              const ad = breadth.advDecline;
              return (
                <Tile
                  label="Advancing today"
                  value={`${ad.adv}/${ad.total}`}
                  valueColor={zone(ad.pctAdv)}
                  sub={`${ad.adv} up · ${ad.dec} down · ${ad.flat} flat`}
                  tip={TIPS.ad}
                />
              );
            })()}
            {(() => {
              const nhl = breadth.newHighsLows;
              const pct = nhl.total ? ((nhl.atHigh + 0.5 * nhl.near) / nhl.total) * 100 : 0;
              return (
                <Tile
                  label="New highs / lows"
                  value={`${nhl.atHigh}↑ / ${nhl.below}↓`}
                  valueColor={zone(pct)}
                  sub={`${nhl.atHigh} new high · ${nhl.near} near · ${nhl.below} below`}
                  tip={TIPS.nhl}
                />
              );
            })()}
            {(() => {
              const r = breadth.rsiDist;
              // Amber if either tail is heavy (>40% of loaded), else green.
              const stretched = r.total && (r.overbought / r.total > 0.4 || r.oversold / r.total > 0.4);
              return (
                <Tile
                  label="RSI distribution"
                  value={`${r.overbought} / ${r.oversold}`}
                  valueColor={stretched ? AMBER : GREEN}
                  sub={`${r.overbought} overbought · ${r.oversold} oversold · ${r.neutral} neutral`}
                  tip={TIPS.rsi}
                />
              );
            })()}
            <Tile
              label="Above SMA-20"
              value={`${Math.round(breadth.sma.pct20)}%`}
              valueColor={zone(breadth.sma.pct20)}
              sub={`${breadth.sma.above20names.length} of ${breadth.loadedCount}`}
              tip={TIPS.sma20}
            />
            <Tile
              label="Above SMA-200"
              value={`${Math.round(breadth.sma.pct200)}%`}
              valueColor={zone(breadth.sma.pct200)}
              sub={`${breadth.sma.above200names.length} of ${breadth.loadedCount}`}
              tip={TIPS.sma200}
            />
          </div>

          {/* SMA above/below detail cards */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <MaBreadthCard
              title="SMA-20" subtitle="Short-term trend"
              pct={breadth.sma.pct20}
              aboveNames={breadth.sma.above20names}
              belowNames={breadth.sma.below20names}
            />
            <MaBreadthCard
              title="SMA-200" subtitle="Long-term trend"
              pct={breadth.sma.pct200}
              aboveNames={breadth.sma.above200names}
              belowNames={breadth.sma.below200names}
            />
          </div>
        </>
      )}
    </div>
  );
}
