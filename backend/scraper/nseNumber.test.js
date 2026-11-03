const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseNseNumber, toShares, toLakhs } = require('./nseNumber');

describe('parseNseNumber', () => {
  // The 2026-11-02 break: NSE's live-analysis endpoints switched these fields
  // from numbers to display strings, and Postgres rejected "60.62 L" as a
  // bigint. Every one of these is a value seen in the payload.
  // Found on the first real run, not in the initial sample: NSE renders values
  // under a lakh with a K suffix.
  test('reads the thousand suffix', () => {
    assert.equal(parseNseNumber('72.88 K'), 72_880);
    assert.equal(parseNseNumber('51.83 K'), 51_830);
    assert.equal(toShares('72.88 K'), 72_880);
    assert.equal(toLakhs('51.83 K'), 0.5183);
  });

  test('reads the lac spelling', () => {
    assert.equal(parseNseNumber('1.5 Lacs'), 150_000);
  });

  test('reads lakh and crore suffixes', () => {
    assert.equal(parseNseNumber('109.95 L'), 10_995_000);
    assert.equal(parseNseNumber('289.14 Cr'), 2_891_400_000);
    assert.equal(parseNseNumber('2,759.40 Cr'), 27_594_000_000);
    assert.equal(parseNseNumber('2.52 L'), 252_000);
  });

  // Below a lakh NSE shows the raw figure with Indian digit grouping.
  test('reads a plain grouped number as the raw amount', () => {
    assert.equal(parseNseNumber('45,123'), 45_123);
    assert.equal(parseNseNumber('1,23,456'), 123_456);
    assert.equal(parseNseNumber('987.5'), 987.5);
  });

  test('tolerates spacing and case', () => {
    assert.equal(parseNseNumber(' 1.5  cr '), 15_000_000);
    assert.equal(parseNseNumber('3L'), 300_000);
  });

  test('passes a real number through untouched', () => {
    assert.equal(parseNseNumber(1035104), 1035104);
  });

  test('treats NSE\'s placeholders as absent', () => {
    assert.equal(parseNseNumber('-'), null);
    assert.equal(parseNseNumber(''), null);
    assert.equal(parseNseNumber(null), null);
    assert.equal(parseNseNumber(undefined), null);
  });

  // The way this broke is exactly why an unknown format must fail LOUD: a
  // silent null would have written empty rows and a green run, and the gap
  // would have surfaced weeks later as a hole in the table.
  test('refuses a format it does not recognise rather than guessing', () => {
    assert.throws(() => parseNseNumber('12.3 M'), /unrecognised NSE number/);
    assert.throws(() => parseNseNumber('abc'), /unrecognised NSE number/);
  });
});

describe('toShares', () => {
  test('returns a whole share count from either format', () => {
    assert.equal(toShares('109.95 L'), 10_995_000);
    assert.equal(toShares(1035104), 1035104);
    assert.equal(toShares('-'), null);
  });
});

describe('toLakhs', () => {
  // Turnover has always been stored in rupees LAKHS: ADANIENT on 2026-10-30
  // had ltp 2579.4 x qty 1,035,104 = 2.67e9 rupees stored as 26,697.5. The new
  // strings must land in that same unit, or one column would hold two scales
  // from Nov 3 onwards with nothing to tell them apart.
  test('converts the new strings into the unit the column already uses', () => {
    assert.equal(toLakhs('289.14 Cr'), 28_914);
    assert.equal(toLakhs('84.53 L'), 84.53);
    assert.equal(toLakhs('2,759.40 Cr'), 275_940);
  });

  test('leaves a legacy numeric turnover alone, because it is already lakhs', () => {
    assert.equal(toLakhs(26697.5058784), 26697.5058784);
  });

  test('reads an un-suffixed string as raw rupees', () => {
    assert.equal(toLakhs('50,000'), 0.5);
  });

  test('passes absence through', () => {
    assert.equal(toLakhs('-'), null);
  });
});
