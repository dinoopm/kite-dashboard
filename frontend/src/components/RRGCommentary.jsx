import { useMemo, useState } from 'react';
import { QUADRANT_ORDER, SORTS, summarizeRotation, weekInProgress } from '../lib/rrgCommentary';
import './RRGCommentary.css';

// ─── Rotation commentary under the RRG ──────────────────────────────────────
//
// Every word here comes from lib/rrgCommentary, which reads the same tail
// window the chart draws. This file only lays it out: an at-a-glance strip,
// then one card per sector with its own miniature tail so a card can be read
// without scrolling back up to the chart. Hovering a card highlights that
// trail on the chart; pinning it keeps the highlight while you read.

const QUADRANT_MEANING = {
  Leading: 'ahead of {B}, momentum rising',
  Weakening: 'ahead of {B}, momentum falling',
  Lagging: 'behind {B}, momentum falling',
  Improving: 'behind {B}, momentum rising',
};
const COMPASS_LABEL = {
  up: 'Up', 'up-right': 'Up & right', right: 'Right', 'down-right': 'Down & right',
  down: 'Down', 'down-left': 'Down & left', left: 'Left', 'up-left': 'Up & left', still: 'Holding still',
};
const FACT_ICON = { crossing: '⇄', tenure: '◷', route: '⤳', turn: '↺', pace: '»', centre: '◎' };

const OPEN_KEY = 'rrgCommentary.open';

const fmt = (v) => v.toFixed(1);
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/** A miniature RRG holding just this sector's tail, on the panel's shared scale. */
function TailGlyph({ tail, color, halfRange, quadrantColors, size = 68 }) {
  const c = size / 2;
  const k = (c - 5) / halfRange;
  const clamp = (v) => Math.max(3, Math.min(size - 3, v));
  const pts = tail.map(p => [clamp(c + (p.rsRatio - 100) * k), clamp(c - (p.rsMomentum - 100) * k)]);
  const end = pts[pts.length - 1];
  return (
    <svg className="rrgc-glyph" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect x="0" y="0" width={c} height={c} fill={quadrantColors.Improving.bg} />
      <rect x={c} y="0" width={c} height={c} fill={quadrantColors.Leading.bg} />
      <rect x="0" y={c} width={c} height={c} fill={quadrantColors.Lagging.bg} />
      <rect x={c} y={c} width={c} height={c} fill={quadrantColors.Weakening.bg} />
      <line x1={c} y1="0" x2={c} y2={size} stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      <line x1="0" y1={c} x2={size} y2={c} stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      {pts.length > 1 && (
        <polyline points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={color}
          strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
      )}
      {pts.length > 1 && <circle cx={pts[0][0]} cy={pts[0][1]} r="1.6" fill={color} opacity="0.55" />}
      <circle cx={end[0]} cy={end[1]} r="3.6" fill={color} stroke="#0f172a" strokeWidth="1.5" />
    </svg>
  );
}

/** Arrow pointing the way the tail last moved, at its true angle. */
function HeadingChip({ heading }) {
  if (!heading) return null;
  const still = heading.compass === 'still';
  return (
    <span className="rrgc-chip" title={`Last ${heading.steps} week${heading.steps === 1 ? '' : 's'}: RS-Ratio ${signed(heading.dx)}, RS-Momentum ${signed(heading.dy)}`}>
      {still ? <span aria-hidden="true">•</span> : (
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: `rotate(${-heading.angle}deg)` }}>
          <path d="M1 6h8.5M6.5 2.5 10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {COMPASS_LABEL[heading.compass]}
      <span className="rrgc-chip-dim">{heading.steps}w</span>
    </span>
  );
}

function StatRow({ label, from, to }) {
  const d = to - from;
  return (
    <div className="rrgc-stat">
      <dt>{label}</dt>
      <dd>
        <span className="rrgc-stat-from">{fmt(from)}</span>
        <span className="rrgc-stat-arrow" aria-hidden="true">→</span>
        <span className="rrgc-stat-to">{fmt(to)}</span>
        <span className={`rrgc-delta ${d > 0 ? 'is-up' : d < 0 ? 'is-down' : ''}`}>{d > 0 ? '▲' : d < 0 ? '▼' : '■'} {signed(d)}</span>
      </dd>
    </div>
  );
}

function SectorCard({ read, index, color, label, subtitle, plotted, pinned, focused, dimmed, halfRange, quadrantColors, onHover, onTogglePin, onLocate, onPlot }) {
  const qc = quadrantColors[read.quadrant];
  const fresh = read.lastCrossing && read.lastCrossing.weeksAgo <= 1 && read.lastCrossing.to === read.quadrant;
  const cls = ['rrgc-card', focused && 'is-focused', pinned && 'is-pinned', dimmed && 'is-dimmed', !plotted && 'is-unplotted'].filter(Boolean).join(' ');
  return (
    <article
      className={cls}
      style={{ '--q': qc.border, '--c': color, '--i': Math.min(index, 12) }}
      onMouseEnter={() => onHover(read.key)}
      onMouseLeave={() => onHover(null)}
      onClick={() => plotted && onTogglePin(read.key)}
    >
      <header className="rrgc-card-head">
        <TailGlyph tail={read.tail} color={color} halfRange={halfRange} quadrantColors={quadrantColors} />
        <div className="rrgc-card-title">
          <div className="rrgc-name">
            <span className="rrgc-dot" style={{ background: color }} />
            <span className="rrgc-name-text">{label}</span>
          </div>
          {subtitle && <div className="rrgc-sub">{subtitle}</div>}
          <div className="rrgc-badges">
            <span className="rrgc-quadrant" style={{ color: qc.text, borderColor: `${qc.border}55`, background: qc.bg }}>{read.quadrant}</span>
            <HeadingChip heading={read.heading} />
            {fresh && <span className="rrgc-chip is-fresh">New in {read.quadrant}</span>}
            {read.pace === 'accelerating' && <span className="rrgc-chip">Speeding up</span>}
            {read.pace === 'slowing' && <span className="rrgc-chip">Slowing</span>}
          </div>
        </div>
        {plotted ? (
          <button type="button" className="rrgc-icon-btn" aria-pressed={pinned}
            title={pinned ? 'Stop highlighting' : 'Highlight on chart'}
            onClick={(e) => { e.stopPropagation(); onLocate(read.key); }}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="1.8" fill="currentColor" />
              <path d="M8 0.5v2.5M8 13v2.5M0.5 8h2.5M13 8h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <button type="button" className="rrgc-plot-btn" onClick={(e) => { e.stopPropagation(); onPlot(read.key); }}>+ Plot</button>
        )}
      </header>

      <p className="rrgc-headline">{read.headline}</p>

      {read.weeks > 0 && (
        <dl className="rrgc-stats" aria-label={`Change over ${read.weeks} weeks`}>
          <div className="rrgc-stats-cap">Across the tail · {read.weeks} wk{read.weeks === 1 ? '' : 's'}</div>
          <StatRow label="RS-Ratio" from={read.first.rsRatio} to={read.latest.rsRatio} />
          <StatRow label="Momentum" from={read.first.rsMomentum} to={read.latest.rsMomentum} />
        </dl>
      )}

      {read.facts.length > 0 && (
        <ul className="rrgc-facts">
          {read.facts.map((f, i) => (
            <li key={i} data-kind={f.kind}>
              <span className="rrgc-fact-icon" aria-hidden="true">{FACT_ICON[f.kind] || '•'}</span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function Segmented({ value, onChange, options, label }) {
  return (
    <div className="rrgc-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" className={value === o.value ? 'is-active' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NameLink({ read, colorFor, labelFor, onHover, onTogglePin }) {
  return (
    <button type="button" className="rrgc-name-link" onMouseEnter={() => onHover(read.key)} onMouseLeave={() => onHover(null)} onClick={() => onTogglePin(read.key)}>
      <span className="rrgc-dot" style={{ background: colorFor(read.key) }} />
      {labelFor(read)}
    </button>
  );
}

export default function RRGCommentary({
  reads, plottedKeys, colorFor, labelFor, subtitleFor, benchmarkLabel, tailLength,
  quadrantColors, hoverKey, pinnedKey, onHover, onTogglePin, onLocate, onPlot,
}) {
  const [scope, setScope] = useState('plotted');
  const [sort, setSort] = useState('rotation');
  // Collapsed by default — the cards are long and the RRG page was crowded
  // with them open. The choice is a per-viewer convenience, so it lives in
  // localStorage and the panel still works when storage is unavailable.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
  });
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* storage blocked: session-only */ }
    // A pin set from a card would keep dimming the chart with no card left
    // on screen to explain it.
    if (!next && pinnedKey) onTogglePin(pinnedKey);
  };

  const plottedReads = useMemo(() => reads.filter(r => plottedKeys.has(r.key)), [reads, plottedKeys]);
  const shown = scope === 'plotted' ? plottedReads : reads;
  const sorted = useMemo(() => [...shown].sort(SORTS[sort]), [shown, sort]);
  const summary = useMemo(() => summarizeRotation(shown), [shown]);

  // Glyph scale: each card zooms to fit its own tail AND the centre, so the
  // shape (a hook, a slide) is legible even when one outlier spans 30 points.
  // The floor — a third of the widest tail on the panel — stops a sector
  // hugging 100 from being blown up until a 0.5-point wobble looks like a
  // 30-point slide. Magnitudes live in the numbers below each glyph.
  const glyphFloor = useMemo(() => {
    let m = 1;
    for (const r of shown) for (const p of r.tail) m = Math.max(m, Math.abs(p.rsRatio - 100), Math.abs(p.rsMomentum - 100));
    return m / 3;
  }, [shown]);
  const halfRangeFor = (r) => {
    let m = glyphFloor;
    for (const p of r.tail) m = Math.max(m, Math.abs(p.rsRatio - 100), Math.abs(p.rsMomentum - 100));
    return m * 1.08;
  };

  const windowEnd = reads.reduce((d, r) => (r.latest.date > d ? r.latest.date : d), '');
  const inProgress = weekInProgress(windowEnd);
  const B = benchmarkLabel;

  if (reads.length === 0) return null;

  const linkProps = { colorFor, labelFor, onHover, onTogglePin };
  const cardFor = (r, i) => (
    <SectorCard key={r.key} read={r} index={i}
      color={colorFor(r.key)} label={labelFor(r)} subtitle={subtitleFor(r)}
      plotted={plottedKeys.has(r.key)} pinned={pinnedKey === r.key}
      focused={hoverKey === r.key || pinnedKey === r.key}
      dimmed={!!pinnedKey && pinnedKey !== r.key && hoverKey !== r.key}
      halfRange={halfRangeFor(r)} quadrantColors={quadrantColors}
      onHover={onHover} onTogglePin={onTogglePin} onLocate={onLocate} onPlot={onPlot} />
  );

  let body;
  if (sorted.length === 0) {
    body = (
      <div className="rrgc-empty">
        Nothing is plotted. Pick sectors in the legend above, or <button type="button" className="rrgc-inline-btn" onClick={() => setScope('all')}>read all {reads.length}</button>.
      </div>
    );
  } else if (sort === 'rotation') {
    // Grouped in the order a tail travels round the chart, so the page reads
    // like the picture: each band says in words what its quadrant means.
    let i = 0;
    body = QUADRANT_ORDER.map(q => {
      const group = sorted.filter(r => r.quadrant === q);
      if (group.length === 0) return null;
      const qc = quadrantColors[q];
      return (
        <section key={q} className="rrgc-group">
          <h5 className="rrgc-group-head" style={{ '--q': qc.border }}>
            <span className="rrgc-group-name" style={{ color: qc.text }}>{q}</span>
            <span className="rrgc-group-count">{group.length}</span>
            <span className="rrgc-group-meaning">{QUADRANT_MEANING[q].replace('{B}', B)}</span>
          </h5>
          <div className="rrgc-grid">{group.map(r => cardFor(r, i++))}</div>
        </section>
      );
    });
  } else {
    body = <div className="rrgc-grid">{sorted.map(cardFor)}</div>;
  }

  const bm = summary.biggestMove;
  const st = summary.strongest;

  return (
    <div className={`rrgc${open ? ' is-open' : ''}`}>
      <button type="button" className="rrgc-toggle" aria-expanded={open} aria-controls="rrgc-panel" onClick={toggleOpen}>
        <span className="rrgc-title">Rotation commentary</span>
        <span className="rrgc-toggle-summary" aria-hidden={open}>
          {QUADRANT_ORDER.map(q => (
            <span key={q} className={summary.counts[q] === 0 ? 'is-zero' : ''}>
              <i style={{ background: quadrantColors[q].border }} />{summary.counts[q]} {q}
            </span>
          ))}
          {summary.fresh.length > 0 && <span className="rrgc-toggle-fresh">{summary.fresh.length} fresh crossing{summary.fresh.length === 1 ? '' : 's'}</span>}
        </span>
        <span className="rrgc-toggle-action">
          {open ? 'Hide' : 'Show'}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
      <div id="rrgc-panel" className="rrgc-panel">
      <div className="rrgc-head">
        <div>
          <p className="rrgc-lede">
            How each tail moved over the {tailLength} weeks to <strong>{windowEnd ? fmtDate(windowEnd) : '—'}</strong>, measured against <strong>{B}</strong>.
          </p>
        </div>
        <div className="rrgc-controls">
          <Segmented label="Which sectors" value={scope} onChange={setScope}
            options={[{ value: 'plotted', label: `Plotted (${plottedReads.length})` }, { value: 'all', label: `All (${reads.length})` }]} />
          <Segmented label="Order" value={sort} onChange={setSort}
            options={[{ value: 'rotation', label: 'By quadrant' }, { value: 'movers', label: 'Biggest moves' }, { value: 'recent', label: 'Recent crossings' }]} />
        </div>
      </div>

      {inProgress && (
        <div className="rrgc-note" role="note">
          <span className="rrgc-note-dot" aria-hidden="true" />
          The latest point is the week still trading (to {fmtDay(windowEnd)}). It keeps moving until that close, so read its last step loosely.
        </div>
      )}

      {shown.length > 0 && (
        <div className="rrgc-glance">
          <div className="rrgc-tile rrgc-tile-wide">
            <div className="rrgc-tile-label">Where they sit</div>
            <div className="rrgc-dist-bar" role="img" aria-label={QUADRANT_ORDER.map(q => `${q} ${summary.counts[q]}`).join(', ')}>
              {QUADRANT_ORDER.filter(q => summary.counts[q] > 0).map(q => (
                <span key={q} style={{ flexGrow: summary.counts[q], background: quadrantColors[q].border }} title={`${q}: ${summary.counts[q]}`} />
              ))}
            </div>
            <div className="rrgc-dist-legend">
              {QUADRANT_ORDER.map(q => (
                <span key={q} className={summary.counts[q] === 0 ? 'is-zero' : ''}>
                  <i style={{ background: quadrantColors[q].border }} />{q} <b>{summary.counts[q]}</b>
                </span>
              ))}
            </div>
          </div>

          <div className="rrgc-tile">
            <div className="rrgc-tile-label">Ahead of {B}</div>
            <div className="rrgc-tile-value">{summary.ahead}<span className="rrgc-tile-of"> / {summary.total}</span></div>
            <div className="rrgc-tile-note">RS-Ratio at or above 100</div>
          </div>

          <div className="rrgc-tile">
            <div className="rrgc-tile-label">Furthest ahead</div>
            {st ? (
              <>
                <div className="rrgc-tile-name"><NameLink read={st} {...linkProps} /></div>
                <div className="rrgc-tile-note">Ratio {fmt(st.latest.rsRatio)} · Momentum {fmt(st.latest.rsMomentum)}</div>
              </>
            ) : <div className="rrgc-tile-note">Nothing in Leading</div>}
          </div>

          <div className="rrgc-tile">
            <div className="rrgc-tile-label">Biggest move</div>
            {bm ? (
              <>
                <div className="rrgc-tile-name"><NameLink read={bm} {...linkProps} /></div>
                <div className="rrgc-tile-note">Ratio {signed(bm.delta.rsRatio)} · Momentum {signed(bm.delta.rsMomentum)} in {bm.weeks} wks</div>
              </>
            ) : <div className="rrgc-tile-note">—</div>}
          </div>

          <div className="rrgc-tile">
            <div className="rrgc-tile-label">Fresh crossings</div>
            {summary.fresh.length > 0 ? (
              <div className="rrgc-fresh-list">
                {summary.fresh.slice(0, 3).map(r => (
                  <div key={r.key} className="rrgc-fresh-item">
                    <NameLink read={r} {...linkProps} />
                    <span className="rrgc-fresh-to" style={{ color: quadrantColors[r.quadrant].text }}>→ {r.quadrant}</span>
                  </div>
                ))}
                {summary.fresh.length > 3 && <div className="rrgc-tile-note">+{summary.fresh.length - 3} more</div>}
              </div>
            ) : <div className="rrgc-tile-note">No quadrant changes in the last 2 weeks</div>}
          </div>
        </div>
      )}

      <div className="rrgc-body">{body}</div>

      <p className="rrgc-foot">
        <strong>Descriptive only.</strong> This reads position and movement straight off the tails above.
        RRG rotation is not a scored signal in this app (it has no entry in the signal registry), so nothing here is a forecast —
        a sector in Improving has no measured tendency to reach Leading next.
        RS-Ratio ≥ 100 means ahead of {B} on a smoothed basis; RS-Momentum ≥ 100 means that relative trend is gaining.
      </p>
      </div>
      )}
    </div>
  );
}
