const { DateTime } = require('luxon');
const { REMINDER_ZONE } = require('./timeParsing');

// Re-exported under the local name used throughout this module. The zone itself
// is owned by timeParsing so parsing and recurrence can never disagree.
const IST = REMINDER_ZONE;

// Upper bound on catch-up steps when replaying a stale schedule forward, so a
// long outage (or an unsatisfiable pattern) can never spin forever.
const MAX_CATCHUP_ITERATIONS = 400;

/**
 * Compute the next DateTime (in IST) for a given recurrence pattern.
 *
 * @param {DateTime} currentIST - The current scheduled DateTime in IST.
 * @param {string} recurrenceType - Recurrence identifier.
 * @returns {DateTime|null} The next scheduled time or null when not possible.
 */
function getNextRecurrenceDateTime(currentIST, recurrenceType) {
  if (!currentIST || !currentIST.isValid) {
    return null;
  }

  switch (recurrenceType) {
    case 'hourly':
      return currentIST.plus({ hours: 1 });
    case 'daily':
      return currentIST.plus({ days: 1 });
    case 'weekday': {
      let next = currentIST.plus({ days: 1 });
      let guard = 0;
      while (next.weekday > 5) {
        next = next.plus({ days: 1 });
        guard += 1;
        if (guard > 7) {
          return null;
        }
      }
      return next;
    }
    case 'weekly':
      return currentIST.plus({ weeks: 1 });
    case 'monthly':
      return currentIST.plus({ months: 1 });
    case 'yearly':
      return currentIST.plus({ years: 1 });
    default:
      return null;
  }
}

// Patterns whose period is a fixed calendar step, so whole periods can be
// skipped in a single jump.
//
// Monthly and yearly are deliberately absent, because `plus({ months: n })`
// clamps month ends differently from n single steps, so bulk-jumping them would
// change existing schedules. They stay single-stepped, which bounds them by
// MAX_CATCHUP_ITERATIONS: roughly 33 years of anchor age for monthly and 400 for
// yearly. That is anchor age, not outage length -- `/rme` rejects past times and
// every rollover rewrites the anchor, so no normal flow gets near it.
//
// `weekday` maps to whole weeks, which is only equivalent to stepping because the
// cadence is EVERY weekday: a jump landing mid-weekend re-converges on the next
// Monday, which is in the occurrence set anyway. A cadence like "every other
// weekday" would break silently here.
//
// All of this also assumes REMINDER_ZONE is fixed-offset (see bulkAdvance).
const BULK_ADVANCE_UNIT = {
  hourly: 'hours',
  daily: 'days',
  weekly: 'weeks',
  // Whole weeks preserve the weekday and hour; the step loop finishes the job.
  weekday: 'weeks'
};

/**
 * Skip whole periods in one jump, so catch-up cost does not scale with the
 * length of an outage.
 *
 * An hourly reminder stepped an hour at a time needs 400 steps to cross 17 days,
 * which exhausted the iteration guard and reported the series as unsatisfiable,
 * which in turn had the startup scan delete the record. The last period is left
 * to the caller's step loop: that keeps weekend skipping exact and guarantees the
 * result is still at or before `afterIST`.
 *
 * @param {DateTime} fromIST - Current candidate occurrence.
 * @param {DateTime} afterIST - The occurrence must end up strictly after this.
 * @param {string} recurrenceType - Recurrence identifier.
 * @returns {DateTime} `fromIST`, or a later occurrence still at or before `afterIST`.
 */
function bulkAdvance(fromIST, afterIST, recurrenceType) {
  const unit = BULK_ADVANCE_UNIT[recurrenceType];
  if (!unit) {
    return fromIST;
  }
  // Returns a sentinel rather than throwing, matching the rest of this module.
  // An invalid DateTime makes the diff NaN, and `NaN <= 0` is false, so without
  // this the arithmetic below would reach `plus({ unit: NaN })` and throw.
  if (!fromIST || !fromIST.isValid || !afterIST || !afterIST.isValid) {
    return fromIST;
  }

  const periods = Math.floor(afterIST.diff(fromIST, unit).as(unit)) - 1;
  if (!Number.isFinite(periods) || periods <= 0) {
    return fromIST;
  }

  // `periods` is floor(diff) - 1, so the jump cannot overshoot `afterIST` for a
  // fixed-offset zone. The check is kept as a cheap backstop in case
  // REMINDER_ZONE ever moves to a zone with DST, where a whole-unit jump and a
  // whole-unit diff can disagree by an hour.
  const jumped = fromIST.plus({ [unit]: periods });
  return jumped.isValid && jumped <= afterIST ? jumped : fromIST;
}

/**
 * Resolve the next occurrence of a recurring reminder from its anchor.
 *
 * The anchor is the canonical scheduled time (e.g. daily 8 AM) and is the only
 * value a recurrence may be derived from. Deriving it from `remindAt` instead
 * would let a one-off snooze permanently rewrite the schedule, because snoozing
 * overwrites `remindAt`.
 *
 * The anchor itself is a candidate result: once an occurrence fires, the anchor
 * already points at the next un-fired occurrence, so blindly advancing would
 * skip it.
 *
 * @param {string} anchorISO - ISO string of the current recurrence anchor.
 * @param {string} recurrenceType - Recurrence identifier.
 * @param {DateTime} afterIST - The occurrence must fall strictly after this.
 * @returns {DateTime|null} The next occurrence, or null when none can be produced.
 */
function computeNextRecurrence(anchorISO, recurrenceType, afterIST) {
  let nextIST = DateTime.fromISO(anchorISO).setZone(IST);
  if (!nextIST.isValid || !afterIST || !afterIST.isValid) {
    return null;
  }

  // Unconditional: bulkAdvance already no-ops when fewer than two whole periods
  // separate the anchor from the floor.
  nextIST = bulkAdvance(nextIST, afterIST, recurrenceType);

  let iterations = 0;
  while (nextIST <= afterIST) {
    // Checked before stepping: the guard must not discard an occurrence that the
    // final step has already carried past the floor.
    if (iterations >= MAX_CATCHUP_ITERATIONS) {
      return null;
    }
    nextIST = getNextRecurrenceDateTime(nextIST, recurrenceType);
    if (!nextIST) {
      return null;
    }
    iterations += 1;
  }
  return nextIST;
}

/**
 * Lower bound for the next occurrence of an owning reminder that just fired.
 *
 * Guards against `node-schedule` invoking the callback a few milliseconds early:
 * if the next occurrence only had to clear `now`, it could resolve to the very
 * instant that just fired and then be dropped as "in the past" when rescheduled,
 * silently killing the series.
 *
 * @param {string} firedISO - ISO string of the occurrence that just fired.
 * @param {DateTime} nowIST - Current time in IST.
 * @returns {DateTime} The instant the next occurrence must fall strictly after.
 */
function resolveRecurrenceFloor(firedISO, nowIST) {
  const firedIST = DateTime.fromISO(firedISO).setZone(IST);
  return firedIST.isValid && firedIST > nowIST ? firedIST : nowIST;
}

module.exports = {
  IST,
  MAX_CATCHUP_ITERATIONS,
  getNextRecurrenceDateTime,
  bulkAdvance,
  computeNextRecurrence,
  resolveRecurrenceFloor
};
