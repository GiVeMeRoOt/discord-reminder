const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const {
  IST,
  computeNextRecurrence,
  resolveRecurrenceFloor
} = require('./recurrence');

const at = (day, hour, minute = 0) =>
  DateTime.fromObject({ year: 2026, month: 7, day, hour, minute }, { zone: IST });

/**
 * Replay the production sequence for a firing occurrence: resolve the next
 * occurrence from the anchor, then roll both remindAt and the anchor forward.
 */
function fire(state, nowIST) {
  const afterIST = resolveRecurrenceFloor(state.remindAt, nowIST);
  const nextIST = computeNextRecurrence(state.anchor, state.type, afterIST);
  if (!nextIST) return { ...state, dead: true };
  return { ...state, remindAt: nextIST.toISO(), anchor: nextIST.toISO() };
}

/** Snooze only moves remindAt; the anchor is deliberately left untouched. */
function snooze(state, untilIST) {
  return { ...state, remindAt: untilIST.toISO() };
}

const daily8am = () => ({
  type: 'daily',
  remindAt: at(27, 8).toISO(),
  anchor: at(27, 8).toISO()
});

test('daily reminder keeps its 8 AM slot after a snooze', () => {
  let s = daily8am();

  // 8 AM day 1 fires -> schedule rolls to 8 AM day 2.
  s = fire(s, at(27, 8));
  assert.strictEqual(DateTime.fromISO(s.remindAt).setZone(IST).toISO(), at(28, 8).toISO());

  // User snoozes the day-1 message at 9:30 for 2 hours.
  s = snooze(s, at(27, 11, 30));

  // The snoozed occurrence fires at 11:30 and must NOT consume day 2.
  s = fire(s, at(27, 11, 30));
  const next = DateTime.fromISO(s.remindAt).setZone(IST);
  assert.strictEqual(next.toISO(), at(28, 8).toISO(), 'day 2 8 AM must not be skipped');

  // Day 2 fires normally -> day 3 at 8 AM. Time of day is stable.
  s = fire(s, at(28, 8));
  assert.strictEqual(DateTime.fromISO(s.remindAt).setZone(IST).toISO(), at(29, 8).toISO());
});

test('repeated snoozing never drifts the recurring slot', () => {
  let s = daily8am();
  for (let day = 27; day < 32; day += 1) {
    s = fire(s, at(day, 8));
    s = snooze(s, at(day, 13, 17));
    s = fire(s, at(day, 13, 17));
    assert.strictEqual(
      DateTime.fromISO(s.anchor).setZone(IST).hour,
      8,
      `anchor drifted on day ${day}`
    );
  }
});

test('anchor already in the future is returned unchanged', () => {
  const next = computeNextRecurrence(at(28, 8).toISO(), 'daily', at(27, 11, 30));
  assert.strictEqual(next.toISO(), at(28, 8).toISO());
});

test('a due anchor advances past the floor', () => {
  const next = computeNextRecurrence(at(27, 8).toISO(), 'daily', at(27, 8));
  assert.strictEqual(next.toISO(), at(28, 8).toISO());
});

test('catches up across a long outage without drifting', () => {
  // Bot offline for days; anchor replays forward to the first future slot.
  const next = computeNextRecurrence(at(27, 8).toISO(), 'daily', at(31, 15));
  const aug1 = DateTime.fromObject({ year: 2026, month: 8, day: 1, hour: 8 }, { zone: IST });
  assert.strictEqual(next.toISO(), aug1.toISO());
  assert.strictEqual(next.hour, 8);
});

test('an early-firing job still moves forward instead of dying', () => {
  // node-schedule invokes the callback 2ms before the scheduled instant.
  const scheduled = at(28, 8);
  const nowIST = scheduled.minus({ milliseconds: 2 });
  const floor = resolveRecurrenceFloor(scheduled.toISO(), nowIST);
  const next = computeNextRecurrence(scheduled.toISO(), 'daily', floor);
  assert.ok(next > scheduled, 'next occurrence must be strictly after the fired one');
  assert.strictEqual(next.toISO(), at(29, 8).toISO());
});

test('legacy records without an anchor still advance from remindAt', () => {
  const fired = at(27, 8);
  const floor = resolveRecurrenceFloor(fired.toISO(), at(27, 8));
  const next = computeNextRecurrence(fired.toISO(), 'daily', floor);
  assert.strictEqual(next.toISO(), at(28, 8).toISO());
});

test('weekday recurrence skips the weekend and keeps the hour', () => {
  // Jul 31 2026 is a Friday.
  const friday = at(31, 8);
  assert.strictEqual(friday.weekday, 5);
  const next = computeNextRecurrence(friday.toISO(), 'weekday', friday);
  assert.strictEqual(next.weekday, 1, 'should land on Monday');
  assert.strictEqual(next.hour, 8);
});

test('snoozing a weekday reminder does not consume the next weekday slot', () => {
  let s = { type: 'weekday', remindAt: at(30, 8).toISO(), anchor: at(30, 8).toISO() };
  s = fire(s, at(30, 8));                    // Thu fires -> Fri Jul 31
  assert.strictEqual(DateTime.fromISO(s.anchor).setZone(IST).toISO(), at(31, 8).toISO());
  s = snooze(s, at(30, 20));                 // snoozed to Thu evening
  s = fire(s, at(30, 20));
  assert.strictEqual(
    DateTime.fromISO(s.remindAt).setZone(IST).toISO(),
    at(31, 8).toISO(),
    'Friday slot must survive the snooze'
  );
});

test('unknown recurrence types and invalid anchors yield null', () => {
  assert.strictEqual(computeNextRecurrence(at(27, 8).toISO(), 'fortnightly', at(27, 8)), null);
  assert.strictEqual(computeNextRecurrence('not-a-date', 'daily', at(27, 8)), null);
});

test('bounded catch-up: hourly cannot replay across an absurd gap', () => {
  // >400 hourly steps must bail out rather than loop.
  const anchor = at(27, 8).minus({ days: 60 });
  assert.strictEqual(computeNextRecurrence(anchor.toISO(), 'hourly', at(27, 8)), null);
});
