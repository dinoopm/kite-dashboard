// India-VIX zone thresholds + lookup, shared by the gauge, the VIX page, and
// the dashboard widget. Kept in a plain module (no components) so fast-refresh
// stays happy in the files that render the gauge.

export const VIX_ZONES = [
  { max: 12, label: 'EXTREME CALM', emoji: '🟢', color: '#10b981', bg: 'rgba(16,185,129,0.12)',
    signal: 'Market may be complacent. Low option premiums — ideal for buying protective puts cheaply. Consider hedging long positions.' },
  { max: 18, label: 'SAFE ZONE', emoji: '🟢', color: '#6ee7b7', bg: 'rgba(110,231,183,0.10)',
    signal: 'Normal market conditions. Trend-following strategies work well. Momentum and breakout plays are reliable.' },
  { max: 25, label: 'ELEVATED CAUTION', emoji: '🟡', color: '#eab308', bg: 'rgba(234,179,8,0.12)',
    signal: 'Volatility is rising. Tighten stop-losses. Reduce position sizes. Avoid over-leveraging. Favour large-caps.' },
  { max: 35, label: 'FEAR SPIKE', emoji: '🔴', color: '#f97316', bg: 'rgba(249,115,22,0.12)',
    signal: 'Short-term panic in play. Contrarian buy opportunities may emerge for quality stocks. Avoid shorting into fear.' },
  { max: 100, label: 'EXTREME FEAR', emoji: '🔴', color: '#ef4444', bg: 'rgba(239,68,68,0.15)',
    signal: 'Capitulation zone. Historically strong long-term equity buy signal. "Be greedy when others are fearful."' },
];

export function getVixZone(vix) {
  for (const z of VIX_ZONES) {
    if (vix <= z.max) return z;
  }
  return VIX_ZONES[VIX_ZONES.length - 1];
}
