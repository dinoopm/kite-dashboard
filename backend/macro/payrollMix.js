// ─── What the payroll number is made of ──────────────────────────────────────
//
// PAYEMS is a headline the panel already scores; this is the same survey split
// into the eleven CES supersectors that compose it. Display only — nothing here
// feeds the composite, and no claim is made about what any of it implies for
// the future. It answers one question: when total nonfarm rose 162k, which
// industries did that?
//
// The supersectors are mutually exclusive and exhaustive, so the parts MUST add
// to the whole. That is not a nicety, it is the check that proves this table
// describes the same universe the score is computed on — and when it cannot be
// performed (a sector missing, or one release behind the rest) the answer is a
// refusal, not a sum over whatever happened to be present. A subset that looks
// like a total is the failure mode worth engineering against here: it would
// under-report a whole industry and still look tidy.
//
// August 2026 is a good illustration of why composition is worth showing at
// all: +162k with leisure and government supplying +97k of it while both ran
// NEGATIVE three-month averages. Same headline, different labour market.

const SUPERSECTORS = [
  { id: 'USMINE', label: 'Mining & logging' },
  { id: 'USCONS', label: 'Construction' },
  { id: 'MANEMP', label: 'Manufacturing' },
  { id: 'USTPU', label: 'Trade, transport & utilities' },
  { id: 'USINFO', label: 'Information' },
  { id: 'USFIRE', label: 'Financial activities' },
  { id: 'USPBS', label: 'Professional & business svcs' },
  { id: 'USEHS', label: 'Private education & health' },
  { id: 'USLAH', label: 'Leisure & hospitality' },
  { id: 'USSERV', label: 'Other services' },
  { id: 'USGOVT', label: 'Government' },
];

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Observations as {date, value}, oldest first, with the blanks dropped. */
function clean(rows) {
  return (rows || [])
    .map(r => ({ date: String(r.observation_date ?? r.date ?? '').slice(0, 10), value: num(r.value) }))
    .filter(r => r.date && r.value != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * The breakdown for the latest month the HEADLINE covers.
 *
 * The headline sets the reference month deliberately: a sector that has not
 * published that month yet is marked stale and named, rather than having its
 * change quietly measured across a different pair of months from everyone
 * else's.
 */
function buildMix(sectorSeries, totalSeries) {
  const total = clean(totalSeries);
  if (!total.length) return null;

  const month = total.at(-1).date;
  const at = (rows, m) => rows.findIndex(r => r.date === m);

  const missing = [];
  const stale = [];
  const rows = SUPERSECTORS.map(({ id, label }) => {
    const o = clean(sectorSeries?.[id]);
    if (!o.length) { missing.push(id); return { id, label, month: null, level: null, change1m: null, avg3m: null, stale: false, missing: true }; }

    const i = at(o, month);
    // Not on the reference month: show what it does have, flagged, and let the
    // reconciliation fail rather than mixing two different months in one column.
    const j = i === -1 ? o.length - 1 : i;
    if (i === -1) stale.push(id);

    return {
      id,
      label,
      month: o[j].date,
      level: o[j].value,
      change1m: j >= 1 ? o[j].value - o[j - 1].value : null,
      avg3m: j >= 3 ? (o[j].value - o[j - 3].value) / 3 : null,
      stale: i === -1,
      missing: false,
    };
  });

  rows.sort((a, b) => (b.change1m ?? -Infinity) - (a.change1m ?? -Infinity));

  const ti = total.length - 1;
  const totalLevel = total[ti].value;
  const totalChange1m = ti >= 1 ? totalLevel - total[ti - 1].value : null;

  const broken = [...missing, ...stale];
  const reconciliation = broken.length
    ? {
      ok: false,
      // Named, so the caveat is actionable rather than a shrug.
      reason: `${broken.join(', ')} ${broken.length === 1 ? 'is' : 'are'} ${missing.length ? 'missing or ' : ''}not on ${month}, so the parts cannot be checked against the headline`,
      sumLevel: null, sumChange1m: null, totalLevel, totalChange1m,
      levelDiff: null, changeDiff: null,
    }
    : (() => {
      const sumLevel = rows.reduce((s, r) => s + r.level, 0);
      const sumChange1m = rows.every(r => r.change1m != null) ? rows.reduce((s, r) => s + r.change1m, 0) : null;
      const levelDiff = sumLevel - totalLevel;
      const changeDiff = sumChange1m == null || totalChange1m == null ? null : sumChange1m - totalChange1m;
      return {
        // CES levels are published to the thousand, so the sum is exact rather
        // than close. A tolerance here would hide a genuinely wrong series.
        ok: levelDiff === 0 && (changeDiff == null || changeDiff === 0),
        reason: null,
        sumLevel, sumChange1m, totalLevel, totalChange1m, levelDiff, changeDiff,
      };
    })();

  return { month, rows, reconciliation, unit: 'thousands of persons' };
}

module.exports = { SUPERSECTORS, buildMix };
