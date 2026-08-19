import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hasTradedVolume, averageVolume, compactVolume } from './volume.js';

describe('hasTradedVolume', () => {
  test('is true for a series that trades', () => {
    assert.equal(hasTradedVolume([{ volume: 0 }, { volume: 1200 }]), true);
  });

  // The case this exists for: an index is a calculation over its members, so
  // Kite reports 0 volume for every bar of NIFTY 50. Drawing a pane of zeroes
  // would say "nothing traded today", which is false and alarming.
  test('is false for an index, which reports zero on every bar', () => {
    assert.equal(hasTradedVolume([{ volume: 0 }, { volume: 0 }]), false);
  });

  test('is false for missing or empty input rather than throwing', () => {
    assert.equal(hasTradedVolume(null), false);
    assert.equal(hasTradedVolume([]), false);
    assert.equal(hasTradedVolume([{}, { close: 5 }]), false);
  });
});

describe('averageVolume', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ volume: (i + 1) * 100 }));

  test('averages only the trailing window, not the whole series', () => {
    // Last 20 of 1..30 hundreds = 11..30 hundreds, mean 20.5 * 100.
    assert.equal(averageVolume(bars, 20), 2050);
  });

  test('ignores zero-volume bars instead of dragging the mean down', () => {
    assert.equal(averageVolume([{ volume: 0 }, { volume: 100 }, { volume: 300 }], 3), 200);
  });

  test('returns null when there is nothing to average', () => {
    assert.equal(averageVolume([{ volume: 0 }], 5), null);
    assert.equal(averageVolume([], 5), null);
    assert.equal(averageVolume(null), null);
  });
});

describe('compactVolume', () => {
  test('scales to the right unit', () => {
    assert.equal(compactVolume(1_250_000_000), '1.25B');
    assert.equal(compactVolume(7_484_912), '7.48M');
    assert.equal(compactVolume(417_407), '417.4K');
    assert.equal(compactVolume(842), '842');
  });

  test('shows an em dash rather than "0" for an absent reading', () => {
    assert.equal(compactVolume(null), '—');
    assert.equal(compactVolume(undefined), '—');
  });
});
