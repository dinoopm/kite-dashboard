// Canonical bull/bear classification — driven by the bullish-bias score so it
// matches the conviction modal. Used by alert filters across pages.
export function biasClass(s) {
  const c = s.confidence ?? 50
  if (c > 60) return 'bullish'
  if (c < 40) return 'bearish'
  return 'mixed'
}
