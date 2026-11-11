// ─── Where a MIXED reading sits between tiers ────────────────────────────────
//
// A tier is the verdict only when EVERY one of its checks passes. MIXED — no
// tier complete — is the usual reading (about 60% of sessions), and on those
// days the panel used to highlight nothing at all, which read as a missing
// selection rather than as "between tiers".
//
// This marks the tier with the largest share of its checks met and names the
// checks it still lacks. It is a description of today's checklist, not a
// forecast and not a verdict: the card is outlined, never filled, and the
// selection proper stays reserved for a tier the rule actually assigned.

/**
 * @param {Array<{id: string, checks: Array<{label: string, pass: boolean|null}>}>} tiers
 * @param {string} state  the assessment's verdict
 */
export function tierProximity(tiers, state) {
  const rows = (tiers || []).map(t => {
    const checks = t.checks || []
    const met = checks.filter(c => c.pass === true).length
    return {
      id: t.id,
      met,
      total: checks.length,
      share: checks.length ? met / checks.length : 0,
      missing: checks.filter(c => c.pass !== true).map(c => c.label),
      nearest: false,
    }
  })
  // Only a MIXED reading has a "between": a real verdict is selected outright,
  // and an incomplete one has missing inputs, which are not distance.
  if (state !== 'MIXED') return rows
  const best = Math.max(0, ...rows.filter(r => r.share < 1).map(r => r.share))
  if (best === 0) return rows
  for (const r of rows) if (r.share === best) r.nearest = true
  return rows
}
