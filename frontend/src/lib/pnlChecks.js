// ─── What the P&L table says about the marks statementChecks.js sets ─────────
//
// The backend compares Yahoo's income statement with the company's filings and
// marks two things without changing any figure: growth that crosses a
// restatement (adjacent years on different bases), and EPS that disagrees with
// the filing after the split adjustment. Net margin is also taken on continuing
// profit when a business was discontinued. These helpers turn those marks into
// what the table shows: which growth cells to withhold, and the hover text.

const money = (n) => {
  const a = Math.abs(n)
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString('en-US')}`
}

/**
 * Why growth from the previous column is withheld for `key`, or null.
 * A restatement withholds only the lines it changed — net income includes the
 * discontinued business either way, so its growth still compares. A disputed
 * EPS withholds growth into AND out of that year.
 */
export function growthBlock(rows, i, key) {
  if (i <= 0) return null
  const cur = rows[i], prev = rows[i - 1]
  const b = cur?.basisBreak
  if (b?.fields?.includes(key)) {
    return {
      kind: 'basis',
      title: `${b.restated} was restated in the filing of ${b.restatedFiled}; ${b.unrestated} comes from an earlier `
        + 'filing that does not restate it. The two periods describe different businesses (a spin-off or '
        + 'reclassification), so growth between them is not shown. Both figures are as filed.',
    }
  }
  if (key === 'eps' && (cur?.epsCheck || prev?.epsCheck)) {
    const bad = cur?.epsCheck ? cur : prev
    return { kind: 'eps', title: `${bad.label} EPS disagrees with the company's filing, so growth through it is not shown.` }
  }
  return null
}

/** Hover text for an EPS that disagrees with the filing, or null. */
export function epsNote(row) {
  const c = row?.epsCheck
  if (!c) return null
  return `${row.label}: Yahoo shows $${row.eps.toFixed(2)}. The company's filing reports $${c.filed.toFixed(2)}, `
    + `which is $${c.expected.toFixed(2)} after adjusting for share-count changes since (×${c.factor.toFixed(2)}). `
    + 'The figure shown is Yahoo\'s; the filing is the primary source.'
}

/** Hover text for a net margin taken on continuing profit, or null. */
export function netMarginNote(row) {
  if (row?.netMarginBasis !== 'continuing') return null
  return `${row.label}: net margin uses profit from continuing operations (${money(row.continuingNetIncome)}). `
    + `Net income above also includes ${money(row.discontinued)} from discontinued operations, whose revenue `
    + 'is no longer in the revenue line, so dividing the two would overstate the margin.'
}
