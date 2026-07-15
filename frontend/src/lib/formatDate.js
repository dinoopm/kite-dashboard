// Shared date display formatting. The app stores and exchanges dates as ISO
// YYYY-MM-DD (sortable, machine-friendly); for display we show the month as a
// 3-letter name — e.g. 2026-07-13 -> 2026-Jul-13 — keeping the same field order.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Local-calendar YYYY-MM-DD for a Date (no UTC shift, so the day never rolls).
function isoLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Rewrite every YYYY-MM-DD occurrence inside a value to YYYY-Mon-DD. Accepts a
// Date, an ISO/date string, or null/undefined. Any trailing time or text is
// preserved (e.g. "2026-07-13 15:30" -> "2026-Jul-13 15:30"); input that holds
// no ISO date is returned unchanged.
export function fmtDate(input) {
  if (input == null) return input;
  const s = input instanceof Date ? isoLocalDate(input) : String(input);
  return s.replace(/(\d{4})-(\d{2})-(\d{2})/g, (m, y, mo, d) => {
    const i = parseInt(mo, 10) - 1;
    return i >= 0 && i < 12 ? `${y}-${MONTHS[i]}-${d}` : m;
  });
}
