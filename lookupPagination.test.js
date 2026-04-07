const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLookupPageLimit } = require('./lookupPagination');

test('uses default limit when maxPages is undefined', () => {
  assert.equal(normalizeLookupPageLimit(undefined, 12), 12);
});

test('preserves explicit Infinity for unbounded lookup', () => {
  assert.equal(normalizeLookupPageLimit(Infinity, 12), Infinity);
});

test('preserves explicit disable values as no fallback (0 or invalid)', () => {
  assert.equal(normalizeLookupPageLimit(0, 12), 0);
  assert.equal(normalizeLookupPageLimit(Number.NaN, 12), 0);
  assert.equal(normalizeLookupPageLimit(-3, 12), 0);
  assert.equal(normalizeLookupPageLimit(null, 12), 0);
});

test('accepts explicit positive finite limits', () => {
  assert.equal(normalizeLookupPageLimit(1, 12), 1);
  assert.equal(normalizeLookupPageLimit(5, 12), 5);
});
