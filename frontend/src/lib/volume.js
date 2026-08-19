// Volume helpers shared by the two instrument pages and the volume pane.
// Kept out of the component file so that file exports only a component, which
// is what React Fast Refresh requires.

/**
 * True when the series carries real traded volume.
 *
 * An index does not: Kite reports 0 volume for NIFTY 50 and the rest, because
 * an index is a calculation over its members rather than something that trades.
 * Callers use this to omit the volume pane entirely instead of drawing an axis
 * over a row of zeroes, which would read as "no trading happened".
 */
export const hasTradedVolume = (data) =>
  Array.isArray(data) && data.some(d => d?.volume > 0);

/** Mean volume over the last `window` bars, ignoring absent bars. */
export function averageVolume(data, window = 20) {
  if (!Array.isArray(data)) return null;
  const recent = data.slice(-window).map(d => d?.volume).filter(v => v > 0);
  if (!recent.length) return null;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** Short human form: 1.2B / 34.5M / 900.1K. */
export function compactVolume(v) {
  if (v == null) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
