const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
const { detectorSourceOf, PRICE_RULE_VERSION } = require('./ruleVersions');

const src = (detectors, blocked) => `${detectors}\nconst BLOCKED_SIGNALS = [\n${blocked}\n];\nconst RECORDED_SIGNALS = [];`;

// Three registry edits in one week, none touching a detector, each split every
// price signal's track record. These hold the line that stops that.
test('editing a blocked or recorded entry does not change the detector source', () => {
  const a = detectorSourceOf(src('function breakout() { return 20; }', "{ name: 'x', blockedReason: 'old words' }"));
  const b = detectorSourceOf(src('function breakout() { return 20; }', "{ name: 'x', blockedReason: 'new words' }, { name: 'y' }"));
  assert.equal(a, b);
});

test('editing a detector does', () => {
  const a = detectorSourceOf(src('function breakout() { return 20; }', ''));
  const b = detectorSourceOf(src('function breakout() { return 55; }', ''));
  assert.notEqual(a, b);
});

// Too many versions is a nuisance; pooling two different rules is a lie.
test('without the marker the whole file counts, as it used to', () => {
  const whole = 'function breakout() {}\nconst SOMETHING_ELSE = [];';
  assert.equal(detectorSourceOf(whole), whole);
});

test('the real registry has the marker, and the detectors sit above it', () => {
  const real = require('fs').readFileSync(require.resolve('./registry'), 'utf8');
  const top = detectorSourceOf(real);
  assert.ok(top.length < real.length);
  assert.match(top, /const PRICE_SIGNALS = \[/);
  assert.doesNotMatch(top, /blockedReason:/);
  assert.match(PRICE_RULE_VERSION, /^price-rules-[0-9a-f]{16}$/);
});
