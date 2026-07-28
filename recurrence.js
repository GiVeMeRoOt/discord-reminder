const { DateTime } = require('luxon');

const IST = 'Asia/Kolkata';

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

  let iterations = 0;
  while (nextIST <= afterIST) {
    nextIST = getNextRecurrenceDateTime(nextIST, recurrenceType);
    if (!nextIST) {
      return null;
    }
    iterations += 1;
    if (iterations >= MAX_CATCHUP_ITERATIONS) {
      return null;
    }
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
  computeNextRecurrence,
  resolveRecurrenceFloor
};
