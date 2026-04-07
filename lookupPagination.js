/**
 * Normalize lookup page limits while preserving explicit "no fallback" caps.
 *
 * Semantics:
 * - `undefined` => use the provided default.
 * - `Infinity` => allow unbounded pagination (explicit opt-in only).
 * - non-finite, non-number, or non-positive values => disable paginated fallback.
 * - positive finite numbers => use as-is.
 *
 * @param {unknown} maxPages
 * @param {number} defaultMaxPages
 * @returns {number}
 */
function normalizeLookupPageLimit(maxPages, defaultMaxPages) {
  if (maxPages === undefined) {
    return defaultMaxPages;
  }

  if (maxPages === Infinity) {
    return Infinity;
  }

  if (typeof maxPages !== 'number' || !Number.isFinite(maxPages) || maxPages <= 0) {
    return 0;
  }

  return maxPages;
}

module.exports = { normalizeLookupPageLimit };
