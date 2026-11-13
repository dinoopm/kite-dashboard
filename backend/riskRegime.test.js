const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indiaNoteFor } = require('./riskRegime');

// The note once claimed a 10Y of "~4.75%+ historically triggers FII selling".
// The app's own FII data showed no such level (see indiaNoteFor), so the note
// must state the mechanism without promising what flows will do at any yield.
test('the India note names the yield without asserting a trigger level', () => {
  for (const y of [3.9, 4.74, 4.75, 5.14, 6.2]) {
    const note = indiaNoteFor(y);
    assert.match(note, new RegExp(`US 10Y at ${y}%`));
    // Checked without the yield figure itself, which is 4.75 for one input.
    const claim = note.replace(/US 10Y at [\d.]+%/, '');
    assert.doesNotMatch(claim, /zone|historically triggers|tend to accelerate|4\.75/, note);
    assert.doesNotMatch(claim, /\bwill\b|\bexpect|\blikely\b/i, note);
  }
});

test('the note reads the same above and below the old threshold', () => {
  const strip = (s) => s.replace(/US 10Y at [\d.]+%/, '');
  assert.equal(strip(indiaNoteFor(4.5)), strip(indiaNoteFor(5.14)));
});
