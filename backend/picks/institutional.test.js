const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { quarterlyChanges } = require('./institutional');

// Oldest → newest, the order indiaInstitutional sorts into. Index 0 from the
// END is the latest quarter and index 2 is the one the comparison runs against.
const q = (label, promoters, fiis, diis) => ({ label, promoters, fiis, diis });

describe('quarterlyChanges', () => {
  // The case that prompted the split. Real TATAELXSI figures: the net is +0.04,
  // which on its own reads as "institutions did nothing", while the legs show a
  // 1.3pp handover from domestic to foreign hands. Both must survive.
  test('reports the legs when they cancel into a near-zero net', () => {
    const c = quarterlyChanges([
      q('Q3 FY26', 43.90, 8.56, 12.28),   // Dec 2025 — the comparison base
      q('Q4 FY26', 43.90, 9.20, 11.39),   // Mar 2026
      q('Q1 FY27', 43.90, 9.85, 11.03),   // Jun 2026 — latest
    ]);
    assert.equal(c.instChange2Q, 0.04);
    assert.equal(c.fiiChange2Q, 1.29);
    assert.equal(c.diiChange2Q, -1.25);
    // The whole point of showing both: the net is an order of magnitude
    // smaller than either move it is made of.
    assert.ok(Math.abs(c.instChange2Q) < Math.abs(c.fiiChange2Q) / 10);
  });

  test('compares against two quarters back, not the previous quarter', () => {
    const c = quarterlyChanges([
      q('Q3 FY26', 50, 10, 10),
      q('Q4 FY26', 50, 99, 99),   // intermediate quarter must not be the base
      q('Q1 FY27', 50, 12, 11),
    ]);
    assert.equal(c.fiiChange2Q, 2);
    assert.equal(c.diiChange2Q, 1);
    assert.equal(c.instChange2Q, 3);
  });

  // The trap the leg computation exists to avoid: `inst` deliberately treats a
  // missing leg as 0 so a company with no FII book still gets a net. A leg must
  // NOT inherit that — it would report the whole DII holding as a fresh move.
  test('suppresses a leg whose own history is incomplete', () => {
    const c = quarterlyChanges([
      q('Q3 FY26', 50, null, 12),   // screener left FII blank two quarters ago
      q('Q4 FY26', 50, 0.5, 11.5),
      q('Q1 FY27', 50, 1, 11),
    ]);
    assert.equal(c.fiiChange2Q, null, 'FII leg has no base to measure from');
    assert.equal(c.diiChange2Q, -1);
    // The net still stands — the blank is read as no FII holding, which for the
    // combined figure is the right reading.
    assert.equal(c.instChange2Q, 0);
  });

  test('returns nulls when a quarter is entirely blank', () => {
    const c = quarterlyChanges([
      q('Q3 FY26', null, null, null),
      q('Q4 FY26', 50, 1, 11.5),
      q('Q1 FY27', 50, 1, 11),
    ]);
    assert.equal(c.instChange2Q, null);
    assert.equal(c.promoterChange2Q, null);
  });

  // Two quarters of history cannot answer a two-quarters-back question. The
  // failure mode being guarded is comparing against whatever is oldest instead.
  test('refuses to answer on fewer than three quarters', () => {
    const c = quarterlyChanges([q('Q4 FY26', 50, 9, 11), q('Q1 FY27', 50, 10, 12)]);
    assert.deepEqual(c, {
      instChange2Q: null, promoterChange2Q: null, fiiChange2Q: null, diiChange2Q: null,
    });
  });

  test('survives no shareholding data at all', () => {
    for (const input of [null, undefined, []]) {
      assert.equal(quarterlyChanges(input).instChange2Q, null);
    }
  });

  // Screener discloses to 2dp; float subtraction does not. 11.03 - 12.28 is
  // -1.2500000000000018 unrounded, which would render as that.
  test('rounds to the 2dp the filings are disclosed at', () => {
    const c = quarterlyChanges([
      q('Q3 FY26', 43.90, 8.56, 12.28),
      q('Q4 FY26', 43.90, 9.20, 11.39),
      q('Q1 FY27', 43.90, 9.85, 11.03),
    ]);
    assert.equal(String(c.diiChange2Q), '-1.25');
  });
});
