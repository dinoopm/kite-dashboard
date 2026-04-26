import { useState, useEffect, useCallback, useMemo } from 'react';

const RRG_COLORS = [
  '#00bcd4', '#ff6384', '#36a2eb', '#ffce56', '#4bc0c0',
  '#9966ff', '#ff9f40', '#e7e9ed', '#22c55e', '#f87171',
  '#a78bfa', '#fb923c', '#38bdf8', '#facc15', '#34d399',
  '#f472b6', '#818cf8'
];

const DEFAULT_VISIBLE_SECTORS = [
  'NSE:NIFTY BANK', 'NSE:NIFTY IT', 'NSE:NIFTY PHARMA', 'NSE:NIFTY AUTO',
  'NSE:NIFTY METAL', 'NSE:NIFTY FMCG'
];

export const QUADRANT_COLORS = {
  Leading:   { bg: 'rgba(34, 197, 94, 0.1)',  border: '#22c55e', text: '#22c55e', emoji: '🟢' },
  Weakening: { bg: 'rgba(234, 179, 8, 0.1)',  border: '#eab308', text: '#eab308', emoji: '🟡' },
  Lagging:   { bg: 'rgba(239, 68, 68, 0.1)',  border: '#ef4444', text: '#ef4444', emoji: '🔴' },
  Improving: { bg: 'rgba(59, 130, 246, 0.1)', border: '#3b82f6', text: '#3b82f6', emoji: '🔵' },
};

const generateSmoothPath = (points) => {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    if (i === 0) {
      path += ` Q ${p1.x} ${p1.y} ${midX} ${midY}`;
    } else {
      path += ` T ${midX} ${midY}`;
    }
  }
  const last = points[points.length - 1];
  path += ` T ${last.x} ${last.y}`;
  return path;
};

export default function RRGChart({
  rrg, rrgLoading, rrgTailLength, setRrgTailLength,
  rrgBenchmark, setRrgBenchmark,
  rrgHidden, setRrgHidden, rrgAnimating, setRrgAnimating,
  rrgAnimFrame, setRrgAnimFrame, rrgScrubEnd, setRrgScrubEnd,
  rrgAnimRef, rrgTooltip, setRrgTooltip, rrgSvgRef, rrgContainerRef, navigate,
  benchmarkReadOnly = false,
}) {
  const CHART_W = 1000, CHART_H = 650;
  const PAD = { top: 40, right: 60, bottom: 65, left: 75 };
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const [quadrantFilter, setQuadrantFilter] = useState(null);
  const [hasInitializedHidden, setHasInitializedHidden] = useState(false);

  useEffect(() => {
    if (rrg && rrg.sectors && rrg.sectors.length > 0 && !hasInitializedHidden) {
      if (!benchmarkReadOnly) {
        const initial = {};
        for (const s of rrg.sectors) {
          if (!DEFAULT_VISIBLE_SECTORS.includes(s.key)) {
            initial[s.key] = true;
          }
        }
        setRrgHidden(initial);
      }
      setHasInitializedHidden(true);
    }
  }, [rrg, hasInitializedHidden, setRrgHidden, benchmarkReadOnly]);

  const getVisibleSeries = useCallback((sector) => {
    if (!sector.series || sector.series.length === 0) return [];
    const total = sector.series.length;
    const endIdx = rrgScrubEnd !== null ? Math.min(rrgScrubEnd, total - 1) : total - 1;
    const startIdx = Math.max(0, endIdx - rrgTailLength + 1);
    if (rrgAnimating) {
      const animEnd = Math.min(startIdx + rrgAnimFrame, endIdx);
      return sector.series.slice(startIdx, animEnd + 1);
    }
    return sector.series.slice(startIdx, endIdx + 1);
  }, [rrgTailLength, rrgScrubEnd, rrgAnimating, rrgAnimFrame]);

  const isSectorVisible = useCallback((sector) => {
    if (rrgHidden[sector.key]) return false;
    if (quadrantFilter && sector.quadrant !== quadrantFilter) return false;
    return true;
  }, [rrgHidden, quadrantFilter]);

  const axisBounds = useMemo(() => {
    if (!rrg || !rrg.sectors) return { minX: 96, maxX: 104, minY: 96, maxY: 104 };
    let minX = 100, maxX = 100, minY = 100, maxY = 100;
    for (const s of rrg.sectors) {
      if (!isSectorVisible(s)) continue;
      const visible = getVisibleSeries(s);
      for (const pt of visible) {
        if (pt.rsRatio < minX) minX = pt.rsRatio;
        if (pt.rsRatio > maxX) maxX = pt.rsRatio;
        if (pt.rsMomentum < minY) minY = pt.rsMomentum;
        if (pt.rsMomentum > maxY) maxY = pt.rsMomentum;
      }
    }
    const xPad = Math.max((maxX - minX) * 0.18, 1.5);
    const yPad = Math.max((maxY - minY) * 0.18, 1.5);
    return {
      minX: Math.min(minX - xPad, 98.5),
      maxX: Math.max(maxX + xPad, 101.5),
      minY: Math.min(minY - yPad, 98.5),
      maxY: Math.max(maxY + yPad, 101.5)
    };
  }, [rrg, isSectorVisible, getVisibleSeries]);

  const scaleX = (v) => PAD.left + ((v - axisBounds.minX) / (axisBounds.maxX - axisBounds.minX)) * plotW;
  const scaleY = (v) => PAD.top + plotH - ((v - axisBounds.minY) / (axisBounds.maxY - axisBounds.minY)) * plotH;

  const totalWeeks = rrg ? Math.max(...rrg.sectors.map(s => s.series.length), 0) : 0;

  const startAnimation = useCallback(() => { setRrgAnimFrame(0); setRrgAnimating(true); }, [setRrgAnimFrame, setRrgAnimating]);
  const stopAnimation = useCallback(() => { setRrgAnimating(false); if (rrgAnimRef.current) clearInterval(rrgAnimRef.current); rrgAnimRef.current = null; }, [setRrgAnimating, rrgAnimRef]);
  const resetAnimation = useCallback(() => { stopAnimation(); setRrgAnimFrame(0); }, [stopAnimation, setRrgAnimFrame]);

  useEffect(() => {
    if (rrgAnimating) {
      rrgAnimRef.current = setInterval(() => {
        setRrgAnimFrame(prev => {
          if (prev >= rrgTailLength - 1) { clearInterval(rrgAnimRef.current); rrgAnimRef.current = null; setRrgAnimating(false); return rrgTailLength - 1; }
          return prev + 1;
        });
      }, 800);
      return () => { if (rrgAnimRef.current) clearInterval(rrgAnimRef.current); };
    }
  }, [rrgAnimating, rrgTailLength, setRrgAnimFrame, setRrgAnimating, rrgAnimRef]);

  const scrubEndIdx = rrgScrubEnd !== null ? rrgScrubEnd : totalWeeks - 1;

  const getDateRange = () => {
    if (!rrg || !rrg.sectors) return null;
    for (const s of rrg.sectors) {
      if (s.series.length > 0) {
        const visible = getVisibleSeries(s);
        if (visible.length > 0) {
          const endDate = visible[visible.length - 1].date;
          return `${visible.length} weeks ending ${new Date(endDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        }
      }
    }
    return null;
  };

  const getQuadrantLabel = (rsRatio, rsMomentum) => {
    if (rsRatio >= 100 && rsMomentum >= 100) return 'Leading';
    if (rsRatio >= 100 && rsMomentum < 100) return 'Weakening';
    if (rsRatio < 100 && rsMomentum >= 100) return 'Improving';
    return 'Lagging';
  };

  const visibleCount = rrg ? rrg.sectors.filter(s => isSectorVisible(s)).length : 0;

  const showAll = () => { setRrgHidden({}); setQuadrantFilter(null); };
  const hideAll = () => {
    const h = {};
    rrg.sectors.forEach(s => { h[s.key] = true; });
    setRrgHidden(h);
    setQuadrantFilter(null);
  };

  const filterByQuadrant = (q) => {
    if (quadrantFilter === q) { setQuadrantFilter(null); return; }
    setQuadrantFilter(q);
    setRrgHidden({});
  };

  if (rrgLoading && !rrg) {
    return (
      <section className="glass-panel" style={{ padding: '2rem 1.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>Relative Rotation Graph</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 1.5rem 0' }}>
          Benchmark: {rrgBenchmark} &bull; Sectors rotate clockwise through Leading → Weakening → Lagging → Improving
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '320px', gap: '1rem' }}>
          <div className="loader" style={{ width: '48px', height: '48px', borderWidth: '5px' }}></div>
          <div style={{ textAlign: 'center', maxWidth: '420px' }}>
            <div style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 600, marginBottom: '0.4rem' }}>
              Computing relative rotation…
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: '1.5' }}>
              Fetching weekly historical data for {rrgBenchmark.split(':')[1] || rrgBenchmark} and its constituents, then calculating RS-Ratio &amp; RS-Momentum. This usually takes 5–30 seconds on first visit.
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (!rrg || !rrg.sectors || rrg.sectors.length === 0) {
    return (
      <section className="glass-panel" style={{ padding: '2rem 1.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>Relative Rotation Graph</h3>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '240px', gap: '0.75rem' }}>
          <div style={{ fontSize: '2rem', opacity: 0.5 }}>📊</div>
          <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 600 }}>RRG data not available</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', textAlign: 'center', maxWidth: '380px' }}>
            The historical data warmup didn't complete in time. Refresh the page in a few seconds — the backend is still caching candles.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: '0.5rem', padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}
          >
            Reload
          </button>
        </div>
      </section>
    );
  }

  const cx100 = scaleX(100);
  const cy100 = scaleY(100);

  const xTicks = [], yTicks = [];
  const xRange = axisBounds.maxX - axisBounds.minX;
  const xInterval = xRange > 30 ? 5 : xRange > 15 ? 2 : xRange > 8 ? 1 : 0.5;
  const startX = Math.floor(axisBounds.minX / xInterval) * xInterval;
  const endX = Math.ceil(axisBounds.maxX / xInterval) * xInterval;
  for (let v = startX; v <= endX; v += xInterval) xTicks.push(v);

  const yRange = axisBounds.maxY - axisBounds.minY;
  const yInterval = yRange > 30 ? 5 : yRange > 15 ? 2 : yRange > 8 ? 1 : 0.5;
  const startY = Math.floor(axisBounds.minY / yInterval) * yInterval;
  const endY = Math.ceil(axisBounds.maxY / yInterval) * yInterval;
  for (let v = startY; v <= endY; v += yInterval) yTicks.push(v);

  const btnStyle = (active, color) => ({
    padding: '0.35rem 0.75rem',
    borderRadius: '6px',
    border: `1px solid ${active ? (color || 'var(--accent)') : 'var(--border)'}`,
    background: active ? (color ? color + '20' : 'var(--accent)') : 'rgba(255,255,255,0.03)',
    color: active ? (color || '#fff') : 'var(--text-secondary)',
    cursor: 'pointer',
    fontWeight: '600',
    fontSize: '0.8rem',
    transition: 'all 0.2s'
  });

  const sectorsByQuadrant = { Leading: [], Weakening: [], Lagging: [], Improving: [] };
  rrg.sectors.forEach((s, i) => {
    if (sectorsByQuadrant[s.quadrant]) sectorsByQuadrant[s.quadrant].push({ ...s, colorIdx: i });
  });

  const allLabelPositions = [];
  const getAdjustedLabelY = (x, y) => {
    const MIN_GAP = 18;
    let adjustedY = y - 10;
    for (const pos of allLabelPositions) {
      if (Math.abs(pos.x - x) < 70 && Math.abs(pos.y - adjustedY) < MIN_GAP) {
        adjustedY = pos.y - MIN_GAP - 2;
      }
    }
    allLabelPositions.push({ x, y: adjustedY });
    return adjustedY;
  };

  const benchmarkLabel = rrgBenchmark
    ? rrgBenchmark.split(':')[1] || rrgBenchmark
    : 'NIFTY 50';

  return (
    <section className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <div>
          <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1.1rem' }}>Relative Rotation Graph</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
            Sectors rotate clockwise: Leading → Weakening → Lagging → Improving
            {(() => {
              if (!rrg?.sectors?.length) return null;
              let latestDate = null;
              for (const s of rrg.sectors) {
                if (s.series?.length) {
                  const d = s.series[s.series.length - 1].date;
                  if (!latestDate || d > latestDate) latestDate = d;
                }
              }
              if (!latestDate) return null;
              return (
                <> &nbsp;•&nbsp; <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                  Data through {new Date(latestDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span></>
              );
            })()}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Benchmark:</span>
            {benchmarkReadOnly ? (
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent)', background: 'rgba(0,188,212,0.1)', border: '1px solid var(--accent)', borderRadius: '6px', padding: '0.3rem 0.6rem' }}>
                {benchmarkLabel}
              </span>
            ) : (
              <select
                value={rrgBenchmark}
                onChange={e => { setRrgBenchmark(e.target.value); resetAnimation(); }}
                style={{
                  background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                  borderRadius: '6px', padding: '0.3rem 0.5rem', fontSize: '0.85rem', cursor: 'pointer', outline: 'none'
                }}
              >
                <option value="NSE:NIFTY 50">NIFTY 50 (Large Cap)</option>
                <option value="NSE:NIFTY 500">NIFTY 500 (Broad Market)</option>
                <option value="NSE:NIFTY MIDCAP 100">MIDCAP 100 (Growth/Risk)</option>
              </select>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Tail: {rrgTailLength}W</span>
            <input type="range" min="2" max="12" value={rrgTailLength}
              onChange={e => { setRrgTailLength(+e.target.value); resetAnimation(); }}
              style={{ width: '80px', cursor: 'pointer', accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', minWidth: '52px' }}>{rrgTailLength} wks</span>
          </div>
          {!rrgAnimating && rrgAnimFrame === 0 && <button onClick={startAnimation} style={btnStyle(false)}>▶ Animate</button>}
          {rrgAnimating && <button onClick={stopAnimation} style={btnStyle(true)}>⏸ Pause</button>}
          {!rrgAnimating && rrgAnimFrame > 0 && <button onClick={resetAnimation} style={btnStyle(false)}>↺ Reset</button>}
        </div>
      </div>

      {/* Quadrant Filter Bar + Show/Hide controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {Object.entries(QUADRANT_COLORS).map(([q, c]) => {
            const count = sectorsByQuadrant[q]?.length || 0;
            return (
              <button key={q} onClick={() => filterByQuadrant(q)} style={btnStyle(quadrantFilter === q, c.border)}>
                {c.emoji} {q} ({count})
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={showAll} style={btnStyle(false)} title="Show all sectors">Show All</button>
          <button onClick={hideAll} style={btnStyle(false)} title="Hide all sectors">Hide All</button>
        </div>
      </div>

      {/* SVG Chart */}
      <div ref={rrgContainerRef} style={{ width: '100%', overflowX: 'auto', position: 'relative' }}>
        <svg ref={rrgSvgRef} viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{ width: '100%', maxWidth: `${CHART_W}px`, height: 'auto', minHeight: '450px', margin: '0 auto', display: 'block' }}>
          {/* Quadrant backgrounds */}
          <rect x={PAD.left} y={PAD.top} width={Math.max(0, cx100 - PAD.left)} height={Math.max(0, cy100 - PAD.top)} fill={QUADRANT_COLORS.Improving.bg} />
          <rect x={cx100} y={PAD.top} width={Math.max(0, PAD.left + plotW - cx100)} height={Math.max(0, cy100 - PAD.top)} fill={QUADRANT_COLORS.Leading.bg} />
          <rect x={PAD.left} y={cy100} width={Math.max(0, cx100 - PAD.left)} height={Math.max(0, PAD.top + plotH - cy100)} fill={QUADRANT_COLORS.Lagging.bg} />
          <rect x={cx100} y={cy100} width={Math.max(0, PAD.left + plotW - cx100)} height={Math.max(0, PAD.top + plotH - cy100)} fill={QUADRANT_COLORS.Weakening.bg} />

          {/* Plot border */}
          <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />

          {/* Grid lines */}
          {xTicks.map(v => <line key={`xg-${v}`} x1={scaleX(v)} y1={PAD.top} x2={scaleX(v)} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />)}
          {yTicks.map(v => <line key={`yg-${v}`} x1={PAD.left} y1={scaleY(v)} x2={PAD.left + plotW} y2={scaleY(v)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />)}

          {/* Crosshairs at 100,100 */}
          <line x1={cx100} y1={PAD.top} x2={cx100} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.7))' }} />
          <line x1={PAD.left} y1={cy100} x2={PAD.left + plotW} y2={cy100} stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.7))' }} />
          <circle cx={cx100} cy={cy100} r="15" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeDasharray="3 3"/>
          <circle cx={cx100} cy={cy100} r="4" fill="rgba(255,255,255,1)" style={{ filter: 'drop-shadow(0 0 8px rgba(255,255,255,0.9))' }} />

          {/* Quadrant labels */}
          <text x={PAD.left + 12} y={PAD.top + 22} fill="rgba(59, 130, 246, 0.7)" fontSize="14" fontWeight="700">Improving 🔵</text>
          <text x={PAD.left + plotW - 12} y={PAD.top + 22} fill="rgba(34, 197, 94, 0.7)" fontSize="14" fontWeight="700" textAnchor="end">Leading 🟢</text>
          <text x={PAD.left + 12} y={PAD.top + plotH - 12} fill="rgba(239, 68, 68, 0.7)" fontSize="14" fontWeight="700">Lagging 🔴</text>
          <text x={PAD.left + plotW - 12} y={PAD.top + plotH - 12} fill="rgba(234, 179, 8, 0.7)" fontSize="14" fontWeight="700" textAnchor="end">Weakening 🟡</text>

          {/* X axis */}
          {xTicks.map(v => (
            <g key={`xt-${v}`}>
              <line x1={scaleX(v)} y1={PAD.top + plotH} x2={scaleX(v)} y2={PAD.top + plotH + 5} stroke="rgba(255,255,255,0.2)" />
              <text x={scaleX(v)} y={PAD.top + plotH + 20} fill="var(--text-secondary)" fontSize="11" textAnchor="middle">{v}</text>
            </g>
          ))}
          <text x={PAD.left + plotW / 2} y={CHART_H - 10} fill="var(--text-secondary)" fontSize="13" textAnchor="middle" fontWeight="600">JdK RS-Ratio →</text>

          {/* Y axis */}
          {yTicks.map(v => (
            <g key={`yt-${v}`}>
              <line x1={PAD.left - 5} y1={scaleY(v)} x2={PAD.left} y2={scaleY(v)} stroke="rgba(255,255,255,0.2)" />
              <text x={PAD.left - 8} y={scaleY(v) + 4} fill="var(--text-secondary)" fontSize="11" textAnchor="end">{v}</text>
            </g>
          ))}
          <text x={20} y={PAD.top + plotH / 2} fill="var(--text-secondary)" fontSize="13" textAnchor="middle" fontWeight="600" transform={`rotate(-90, 20, ${PAD.top + plotH / 2})`}>JdK RS-Momentum →</text>

          {/* Sector trails */}
          {(() => {
            allLabelPositions.length = 0;
            return rrg.sectors.map((sector, si) => {
              if (!isSectorVisible(sector)) return null;
              const color = RRG_COLORS[si % RRG_COLORS.length];
              const visible = getVisibleSeries(sector);
              if (visible.length === 0) return null;

              const points = visible.map(pt => ({ x: scaleX(pt.rsRatio), y: scaleY(pt.rsMomentum), ...pt }));
              const pathD = generateSmoothPath(points);
              const latest = points[points.length - 1];
              const shortName = sector.name.replace('NIFTY ', '').replace('NIFTY', '');
              const labelY = getAdjustedLabelY(latest.x, latest.y);

              return (
                <g key={sector.key}>
                  <path d={pathD} fill="none" stroke={color} strokeWidth="2.5" opacity="0.85" strokeLinejoin="round" strokeLinecap="round" />
                  {points.map((p, i) => {
                    const isLatest = i === points.length - 1;
                    return (
                      <circle key={i} cx={p.x} cy={p.y}
                        r={isLatest ? 7 : 3.5}
                        fill={isLatest ? color : '#1a1a2e'}
                        stroke={color} strokeWidth={isLatest ? 2.5 : 2}
                        style={{ cursor: 'pointer', transition: 'all 0.3s ease' }}
                        onMouseEnter={(e) => {
                          const rect = rrgContainerRef.current?.getBoundingClientRect();
                          setRrgTooltip({
                            name: sector.name, rsRatio: p.rsRatio, rsMomentum: p.rsMomentum,
                            date: p.date, quadrant: getQuadrantLabel(p.rsRatio, p.rsMomentum),
                            color, x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0)
                          });
                        }}
                        onMouseLeave={() => setRrgTooltip(null)}
                        onClick={(e) => { e.stopPropagation(); navigate(`/instrument/${sector.token}?symbol=${sector.key.split(':')[1]}`); }}
                      />
                    );
                  })}
                  <text x={latest.x + 12} y={labelY + 4}
                    fill="#ffffff"
                    fontSize="13"
                    fontWeight="800"
                    style={{
                      pointerEvents: 'none',
                      textShadow: `0 0 6px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.9), -1px -1px 0 ${color}, 1px -1px 0 ${color}, -1px 1px 0 ${color}, 1px 1px 0 ${color}`
                    }}
                  >{shortName}</text>
                </g>
              );
            });
          })()}
        </svg>

        {/* Tooltip */}
        {rrgTooltip && (
          <div style={{
            position: 'absolute', left: Math.min(rrgTooltip.x + 15, 500), top: rrgTooltip.y - 10,
            background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
            border: `1px solid ${rrgTooltip.color}40`,
            borderRadius: '10px', padding: '0.7rem 1rem',
            boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 12px ${rrgTooltip.color}20`,
            zIndex: 100, pointerEvents: 'none', minWidth: '190px'
          }}>
            <div style={{ fontWeight: 700, color: rrgTooltip.color, marginBottom: '0.3rem', fontSize: '0.95rem' }}>
              {rrgTooltip.name}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>
              Week of {new Date(rrgTooltip.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.2rem 1rem', fontSize: '0.85rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>RS-Ratio:</span>
              <span style={{ fontWeight: 600, color: rrgTooltip.rsRatio >= 100 ? '#22c55e' : '#ef4444' }}>{rrgTooltip.rsRatio}</span>
              <span style={{ color: 'var(--text-secondary)' }}>RS-Momentum:</span>
              <span style={{ fontWeight: 600, color: rrgTooltip.rsMomentum >= 100 ? '#22c55e' : '#ef4444' }}>{rrgTooltip.rsMomentum}</span>
            </div>
            <div style={{ marginTop: '0.35rem', fontSize: '0.85rem', fontWeight: 600, padding: '0.2rem 0.4rem', borderRadius: '4px', background: 'rgba(255,255,255,0.05)', display: 'inline-block' }}>
              {QUADRANT_COLORS[rrgTooltip.quadrant]?.emoji} {rrgTooltip.quadrant}
            </div>
          </div>
        )}
      </div>

      {/* Timeline Scrubber */}
      {totalWeeks > rrgTailLength && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Showing {getDateRange()}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Drag to see historic data</span>
          </div>
          <input type="range" min={rrgTailLength - 1} max={totalWeeks - 1} value={scrubEndIdx}
            onChange={e => { setRrgScrubEnd(+e.target.value); resetAnimation(); }}
            style={{ width: '100%', cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
        </div>
      )}

      {/* Legend — grouped by quadrant */}
      <div style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Showing {visibleCount} of {rrg.sectors.length} sectors — click to toggle
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.5rem' }}>
          {Object.entries(sectorsByQuadrant).map(([quadrant, sectors]) => {
            if (sectors.length === 0) return null;
            const qc = QUADRANT_COLORS[quadrant];
            return (
              <div key={quadrant} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '8px', padding: '0.5rem', border: `1px solid ${qc.border}20` }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, color: qc.text, marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {qc.emoji} {quadrant}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  {sectors.map(s => {
                    const color = RRG_COLORS[s.colorIdx % RRG_COLORS.length];
                    const hidden = rrgHidden[s.key] || (quadrantFilter && s.quadrant !== quadrantFilter);
                    return (
                      <button key={s.key}
                        onClick={() => setRrgHidden(prev => ({ ...prev, [s.key]: !prev[s.key] }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.4rem',
                          padding: '0.2rem 0.4rem', borderRadius: '4px', border: 'none',
                          background: hidden ? 'transparent' : 'rgba(255,255,255,0.04)',
                          cursor: 'pointer', fontSize: '0.78rem',
                          color: hidden ? 'var(--text-secondary)' : 'var(--text-primary)',
                          opacity: hidden ? 0.35 : 1, transition: 'all 0.15s', textAlign: 'left'
                        }}
                      >
                        <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: hidden ? 'var(--text-secondary)' : color, display: 'inline-block', flexShrink: 0 }} />
                        {s.name.replace('NIFTY ', '')}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
