const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { monthlyExpiries, nextExpiry, classifySessions, verifyAgainstVolume } = require('./expiryCalendar');

// Weekday trading calendar generator (Mon–Fri), minus any excluded holidays.
function weekdays(from, to, holidays = []) {
  const skip = new Set(holidays);
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (!skip.has(iso)) out.push(iso);
  }
  return out;
}

describe('monthlyExpiries', () => {
  test('picks the last Thursday of each month', () => {
    // Jul 2026 Thursdays: 02, 09, 16, 23, 30. Aug: 06, 13, 20, 27.
    const cal = weekdays('2026-07-01', '2026-08-31');
    assert.deepEqual(monthlyExpiries(cal), ['2026-07-30', '2026-08-27']);
  });

  // The exchange moves expiry earlier when the last Thursday is a holiday, and
  // a holiday is simply absent from a calendar built from traded sessions.
  test('falls back to the previous session when the last Thursday is a holiday', () => {
    const cal = weekdays('2026-07-01', '2026-07-31', ['2026-07-30']);
    assert.deepEqual(monthlyExpiries(cal), ['2026-07-23'], 'previous Thursday now the last one traded');
  });

  test('uses the last session when no Thursday traded at all', () => {
    const cal = weekdays('2026-07-01', '2026-07-31',
      ['2026-07-02', '2026-07-09', '2026-07-16', '2026-07-23', '2026-07-30']);
    assert.deepEqual(monthlyExpiries(cal), ['2026-07-31']);
  });

  test('handles an empty or missing calendar without throwing', () => {
    assert.deepEqual(monthlyExpiries([]), []);
    assert.deepEqual(monthlyExpiries(null), []);
  });

  test('returns one expiry per month, in order', () => {
    const cal = weekdays('2026-01-01', '2026-12-31');
    const out = monthlyExpiries(cal);
    assert.equal(out.length, 12);
    assert.deepEqual(out, [...out].sort());
    assert.equal(new Set(out.map(d => d.slice(0, 7))).size, 12, 'no month counted twice');
  });
});

describe('nextExpiry', () => {
  const cal = weekdays('2026-07-01', '2026-08-31');

  test('counts the distance in sessions, not calendar days', () => {
    // From Mon 27 Jul to Thu 30 Jul: 27, 28, 29 traded before it = 3 sessions.
    const n = nextExpiry(cal, '2026-07-27');
    assert.equal(n.date, '2026-07-30');
    assert.equal(n.sessionsAway, 3);
  });

  test('reports zero on expiry day itself', () => {
    const n = nextExpiry(cal, '2026-07-30');
    assert.equal(n.date, '2026-07-30');
    assert.equal(n.sessionsAway, 0);
  });

  test('rolls to next month once this one has passed', () => {
    assert.equal(nextExpiry(cal, '2026-07-31').date, '2026-08-27');
  });

  test('marks a settled date as settled', () => {
    assert.equal(nextExpiry(cal, '2026-07-27').projected, false);
  });

  // The brief has to name the NEXT expiry, which by definition has not traded
  // yet. Deriving only from past sessions would report the second-to-last
  // Thursday of the current month as this month's expiry.
  test('projects forward when the calendar has not reached the expiry', () => {
    const short = weekdays('2026-07-01', '2026-07-27'); // month still in progress
    const n = nextExpiry(short, '2026-07-27');
    assert.equal(n.date, '2026-07-30', 'the real last Thursday, not the 23rd');
    assert.equal(n.projected, true);
  });

  test('keeps projecting past the end of the calendar', () => {
    const n = nextExpiry(cal, '2026-12-01');
    assert.equal(n.date, '2026-12-31');
    assert.equal(n.projected, true);
    assert.equal(n.sessionsAway, null, 'no session count beyond the known calendar');
  });
});

describe('monthlyExpiries — settled months only', () => {
  test('excludes a month whose expiry has not traded yet', () => {
    const short = weekdays('2026-07-01', '2026-07-27');
    assert.deepEqual(monthlyExpiries(short), [], 'July is still in progress');
  });

  test('includes the month once its expiry has traded', () => {
    const done = weekdays('2026-07-01', '2026-07-30');
    assert.deepEqual(monthlyExpiries(done), ['2026-07-30']);
  });
});

describe('classifySessions', () => {
  const cal = weekdays('2026-07-01', '2026-07-31');
  const byDate = Object.fromEntries(classifySessions(cal).map(s => [s.date, s]));

  test('marks the expiry session', () => {
    assert.equal(byDate['2026-07-30'].isExpiry, true);
    assert.equal(byDate['2026-07-30'].offset, 0);
  });

  test('signs the offset — negative before expiry, positive after', () => {
    assert.equal(byDate['2026-07-29'].offset, -1);
    assert.equal(byDate['2026-07-31'].offset, 1);
  });

  test('windows the sessions around expiry', () => {
    assert.equal(byDate['2026-07-28'].inExpiryWindow, true, '2 sessions before');
    assert.equal(byDate['2026-07-13'].inExpiryWindow, false, 'mid-month');
  });
});

describe('verifyAgainstVolume', () => {
  const cal = weekdays('2026-07-01', '2026-08-31');
  const expiries = new Set(monthlyExpiries(cal));

  test('confirms the rule when expiry sessions trade heavier', () => {
    const turnover = Object.fromEntries(cal.map(d => [d, expiries.has(d) ? 300 : 100]));
    const v = verifyAgainstVolume(cal, turnover);
    assert.equal(v.ratio, 3);
    assert.equal(v.looksRight, true);
  });

  // The point of the check: if the weekday rule drifts from what NSE does, the
  // derived dates are ordinary sessions and the ratio collapses to ~1.
  test('flags the rule when expiry sessions look like any other day', () => {
    const turnover = Object.fromEntries(cal.map(d => [d, 100]));
    const v = verifyAgainstVolume(cal, turnover);
    assert.equal(v.ratio, 1);
    assert.equal(v.looksRight, false);
  });

  test('ignores sessions with no turnover recorded', () => {
    const turnover = Object.fromEntries(cal.filter(d => !expiries.has(d)).map(d => [d, 100]));
    const v = verifyAgainstVolume(cal, turnover);
    assert.equal(v.expirySessions, 0);
    assert.equal(v.ratio, null);
    assert.equal(v.looksRight, false, 'no evidence is not confirmation');
  });
});
