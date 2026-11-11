// ─── Editing a finished price measurement ───────────────────────────────────
//
// A measurement used to freeze on its second click: adjusting either end meant
// clearing it and placing both points again. These two functions let either
// end be dragged afterwards, and are shared by the Recharts charts (instrument
// pages, VIX) and the lightweight-charts one (Signals tab) so the two cannot
// disagree about what may move.

// How close, in pixels, the pointer must be to an end to grab it. Wider than
// the 5px dot, because a dot is hard to hit; narrow enough that grabbing the
// chart anywhere else still pans it.
export const GRAB_RADIUS = 10

/**
 * The measurement with one end moved. Returns the SAME object when the move is
 * not allowed, so callers can cheaply tell nothing changed.
 */
export function moveEndpoint(state, which, point) {
  if (!state?.start || !state?.end || state.active) return state
  if (!point || !Number.isFinite(point.price)) return state
  // The percentage divides by the start price.
  if (which === 'start') return point.price > 0 ? { ...state, start: point } : state
  if (which === 'end') return { ...state, end: point }
  return state
}

/** Which end, if either, is within the grab radius of (x, y); the closer wins. */
export function nearestEndpoint(from, to, x, y, radius = GRAB_RADIUS) {
  const dist = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? Math.hypot(p.x - x, p.y - y) : Infinity)
  const ds = dist(from), de = dist(to)
  if (Math.min(ds, de) > radius) return null
  return de < ds ? 'end' : 'start'
}
