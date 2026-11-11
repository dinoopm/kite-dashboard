// ─── Where the measurement readout goes ─────────────────────────────────────
//
// The readout must never sit on the selection it describes. It used to aim
// 105px above the selection's top point and clamp to the plot edge when there
// was no room — so any measurement reaching near the top of the chart (a peak,
// most often, which is exactly what people measure to) had its readout pinned
// over the selected range, hiding the box and the line.
//
// Candidates in order — above, below, left, right — each centred on the
// selection along the other axis and clamped inside the plot. The first that
// clears the selection wins. When none does (a selection filling the plot),
// the plot corner that covers the least of it is used.

const MARGIN = 8   // from the plot edge
const GAP = 10     // between the readout and the selection
const PAD = 6      // the endpoint markers overhang the box by their radius

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))

function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * @param {{from:{x,y}, to:{x,y}|null, width:number, height:number, badgeWidth:number, badgeHeight:number}} args
 *   plot-relative pixel coordinates
 * @returns {{left:number, top:number, side:'above'|'below'|'left'|'right'|'corner'}}
 */
export function badgePlacement({ from, to, width, height, badgeWidth, badgeHeight }) {
  const end = to || from
  const sel = {
    x0: Math.min(from.x, end.x) - PAD, x1: Math.max(from.x, end.x) + PAD,
    y0: Math.min(from.y, end.y) - PAD, y1: Math.max(from.y, end.y) + PAD,
  }
  const cx = (sel.x0 + sel.x1) / 2, cy = (sel.y0 + sel.y1) / 2
  const maxLeft = width - badgeWidth - MARGIN, maxTop = height - badgeHeight - MARGIN
  const rectOf = (left, top) => ({ x0: left, x1: left + badgeWidth, y0: top, y1: top + badgeHeight })
  const clear = (left, top) => overlapArea(rectOf(left, top), sel) === 0

  const candidates = [
    { side: 'above', left: clamp(cx - badgeWidth / 2, MARGIN, maxLeft), top: sel.y0 - GAP - badgeHeight },
    { side: 'below', left: clamp(cx - badgeWidth / 2, MARGIN, maxLeft), top: sel.y1 + GAP },
    { side: 'left', left: sel.x0 - GAP - badgeWidth, top: clamp(cy - badgeHeight / 2, MARGIN, maxTop) },
    { side: 'right', left: sel.x1 + GAP, top: clamp(cy - badgeHeight / 2, MARGIN, maxTop) },
  ]
  for (const c of candidates) {
    const fits = c.left >= MARGIN && c.left <= maxLeft && c.top >= MARGIN && c.top <= maxTop
    if (fits && clear(c.left, c.top)) return c
  }

  // Nothing clears it: the corner hiding the least of the selection.
  const corners = [
    { left: MARGIN, top: MARGIN }, { left: maxLeft, top: MARGIN },
    { left: MARGIN, top: maxTop }, { left: maxLeft, top: maxTop },
  ].map(c => ({ ...c, side: 'corner', covered: overlapArea(rectOf(c.left, c.top), sel) }))
  corners.sort((a, b) => a.covered - b.covered)
  const { covered, ...best } = corners[0]
  return best
}
