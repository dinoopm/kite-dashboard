export const SEVERITY_COLORS = { NEUTRAL: '#34d399', CAUTION: '#fbbf24', STRESS: '#fb923c', 'CRASH MODE': '#fb7185', MIXED: '#94a3b8' };

export function annotateSeverity(series, timeline) {
  const dates = new Map((timeline?.series || []).map(point => [point.date, point]));
  return series.map(point => {
    const snapshot = dates.get(point.date);
    return { ...point, riskState: SEVERITY_COLORS[snapshot?.state] ? snapshot.state : null, riskFlags: snapshot?.flags || null };
  });
}

// Missing dates break a band, so Friday's tier never spreads across a newer
// quote or a period with no credit data. The chart decides pixel boundaries.
export function severitySegments(series) {
  const segments = [];
  series.forEach((point, index) => {
    const state = SEVERITY_COLORS[point.riskState] ? point.riskState : null;
    const last = segments.at(-1);
    if (last && last.state === state) { last.last = index; last.to = point.date; }
    else segments.push({ state, first: index, last: index, from: point.date, to: point.date });
  });
  return segments.filter(segment => segment.state);
}
