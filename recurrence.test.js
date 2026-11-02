const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const {
  IST,
  MAX_CATCHUP_ITERATIONS,
  bulkAdvance,
  getNextRecurrenceDateTime,
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

test('hourly catch-up survives a long outage instead of being dropped', () => {
  // 60 days is 1440 single hourly steps, far past MAX_CATCHUP_ITERATIONS. Whole
  // periods are skipped in one jump, so the series keeps its minute slot rather
  // than resolving to null and having the startup scan delete the record.
  const anchor = at(27, 8).minus({ days: 60 });

  const next = computeNextRecurrence(anchor.toISO(), 'hourly', at(27, 8));

  assert.ok(next, 'an hourly series must not be reported as unsatisfiable');
  assert.strictEqual(next.toISO(), at(27, 9).toISO());
  assert.strictEqual(next.minute, 0, 'minute slot must not drift');
});

test('bulk catch-up lands exactly where stepping would, month ends included', () => {
  // The real parity check: step a reference occurrence one period at a time with
  // no jump, then assert the bulk path agrees. Month-end and leap-day anchors are
  // included because that is where whole-unit arithmetic and repeated single
  // steps are most likely to disagree.
  const anchors = [
    at(27, 9, 15),  // Monday
    at(25, 9, 15),  // Saturday, so weekday cadence starts off-set
    DateTime.fromObject({ year: 2026, month: 1, day: 31, hour: 9, minute: 15 }, { zone: IST }),
    DateTime.fromObject({ year: 2028, month: 2, day: 29, hour: 9, minute: 15 }, { zone: IST })
  ];

  for (const anchor of anchors) {
    for (const [type, gap] of [
      ['hourly', { days: 45 }],
      ['daily', { days: 500 }],
      ['weekly', { weeks: 30 }],
      ['weekday', { days: 90 }]
    ]) {
      const afterIST = anchor.plus(gap);

      let stepped = anchor;
      while (stepped <= afterIST) {
        stepped = getNextRecurrenceDateTime(stepped, type);
      }

      const next = computeNextRecurrence(anchor.toISO(), type, afterIST);

      assert.ok(next, `${type} must resolve from ${anchor.toISODate()}`);
      assert.strictEqual(
        next.toISO(),
        stepped.toISO(),
        `${type} bulk jump diverged from stepping at ${anchor.toISODate()}`
      );
      assert.strictEqual(next.minute, 15, `${type} minute slot drifted`);
      if (type === 'weekday') {
        assert.ok(next.weekday <= 5, 'weekday cadence must not land on a weekend');
      }
    }
  }
});

test('bulkAdvance returns a sentinel instead of throwing on invalid input', () => {
  // Every other entry point in this module guards its input and returns a
  // sentinel; a NaN diff must not reach plus({ unit: NaN }), which throws.
  const invalid = DateTime.invalid('deliberately invalid');
  const valid = at(27, 8);

  assert.strictEqual(bulkAdvance(valid, invalid, 'hourly').toISO(), valid.toISO());
  assert.strictEqual(bulkAdvance(invalid, valid, 'hourly').isValid, false);
  assert.strictEqual(bulkAdvance(valid, undefined, 'daily').toISO(), valid.toISO());
});

test('the iteration guard does not discard a just-resolved occurrence', () => {
  // Monthly is stepped one month at a time on purpose, so a gap needing exactly
  // MAX_CATCHUP_ITERATIONS steps used to return null despite having an answer.
  const anchor = at(27, 8);
  const afterIST = anchor.plus({ months: MAX_CATCHUP_ITERATIONS - 1 }).plus({ minutes: 1 });

  const next = computeNextRecurrence(anchor.toISO(), 'monthly', afterIST);

  assert.ok(next, 'exactly MAX_CATCHUP_ITERATIONS steps must still resolve');
  assert.strictEqual(next.toISO(), anchor.plus({ months: MAX_CATCHUP_ITERATIONS }).toISO());
});

// --- bulkAdvance ---------------------------------------------------------------

test('bulkAdvance leaves patterns without a fixed calendar period alone', () => {
  // Monthly and yearly are deliberately absent from BULK_ADVANCE_UNIT, and an
  // unknown pattern must not be jumped either.
  const anchor = at(27, 8);
  const afterIST = anchor.plus({ days: 500 });

  for (const type of ['monthly', 'yearly', 'fortnightly', undefined]) {
    assert.strictEqual(
      bulkAdvance(anchor, afterIST, type).toISO(),
      anchor.toISO(),
      `${type} must be left to the step loop`
    );
  }
});

test('bulkAdvance does not move when less than two whole periods remain', () => {
  // The last period is always left to the caller's step loop, so a gap of one
  // period (or less) has nothing to skip.
  const anchor = at(27, 8);

  assert.strictEqual(bulkAdvance(anchor, anchor, 'daily').toISO(), anchor.toISO());
  assert.strictEqual(bulkAdvance(anchor, anchor.plus({ days: 1 }), 'daily').toISO(), anchor.toISO());
  assert.strictEqual(
    bulkAdvance(anchor, anchor.plus({ days: 1, hours: 12 }), 'daily').toISO(),
    anchor.toISO(),
    'a partial second period must not be skipped'
  );
});

test('bulkAdvance never jumps past the floor it was given', () => {
  // The contract the step loop relies on: the jump lands at or before afterIST,
  // so no occurrence between the jump and the floor can be skipped silently.
  const anchor = at(27, 9, 15);
  for (const [type, gap] of [
    ['hourly', { days: 45 }],
    ['daily', { days: 500 }],
    ['weekly', { weeks: 30 }],
    ['weekday', { days: 90 }]
  ]) {
    const afterIST = anchor.plus(gap);
    const jumped = bulkAdvance(anchor, afterIST, type);

    assert.ok(jumped.isValid, `${type} jump must stay valid`);
    assert.ok(jumped <= afterIST, `${type} jump overshot the floor`);
    assert.ok(jumped >= anchor, `${type} jump must never go backwards`);
  }
});

test('monthly catch-up stays on the single-stepped series', () => {
  // Jan 31 stepped three times clamps to Apr 28; one plus({ months: 3 }) gives
  // Apr 30. That disagreement is why monthly stays out of BULK_ADVANCE_UNIT.
  //
  // This pins catch-up to the SAME series the live rollover produces; it is not a
  // claim that Apr 28 is the right answer. Single-stepping clamps at every short
  // month and the day-of-month ratchets permanently downward, so "monthly on the
  // 31st" decays to the 28th and stays there. That drift predates this change,
  // and fixing it means storing the intended day-of-month and clamping per
  // occurrence, which is a schedule-semantics decision, not a catch-up one.
  const jan31 = DateTime.fromObject({ year: 2026, month: 1, day: 31, hour: 8 }, { zone: IST });

  let stepped = jan31;
  for (let i = 0; i < 3; i += 1) {
    stepped = getNextRecurrenceDateTime(stepped, 'monthly');
  }
  assert.strictEqual(stepped.day, 28, 'stepping clamps at the short month (known drift)');
  assert.notStrictEqual(jan31.plus({ months: 3 }).toISO(), stepped.toISO());

  const next = computeNextRecurrence(jan31.toISO(), 'monthly', jan31.plus({ months: 2 }).plus({ minutes: 1 }));
  assert.strictEqual(next.toISO(), stepped.toISO(), 'catch-up must match the stepped series');
});

// --- iteration guard -----------------------------------------------------------

test('the iteration guard still returns null beyond MAX_CATCHUP_ITERATIONS steps', () => {
  // Monthly is stepped one period at a time, so a gap of 500 months needs more
  // steps than the guard allows and must bail out rather than loop.
  const anchor = at(27, 8);
  const afterIST = anchor.plus({ months: MAX_CATCHUP_ITERATIONS + 100 });

  assert.strictEqual(computeNextRecurrence(anchor.toISO(), 'monthly', afterIST), null);
});

test('a missing or invalid floor yields null instead of looping', () => {
  const anchor = at(27, 8).toISO();

  assert.strictEqual(computeNextRecurrence(anchor, 'daily', null), null);
  assert.strictEqual(computeNextRecurrence(anchor, 'daily', undefined), null);
  assert.strictEqual(computeNextRecurrence(anchor, 'daily', DateTime.invalid('broken')), null);
});

test('weekday catch-up from a weekend anchor lands on a weekday', () => {
  // A legacy record has no anchor, so catch-up falls back to remindAt, which a
  // snooze can have parked on a Saturday. The bulk jump preserves that Saturday,
  // so the step loop has to be the thing that clears the weekend.
  const saturday = at(25, 8);
  assert.strictEqual(saturday.weekday, 6, 'Jul 25 2026 must be a Saturday');

  const next = computeNextRecurrence(saturday.toISO(), 'weekday', saturday.plus({ days: 120 }));

  assert.ok(next, 'a weekday series must survive a long outage');
  assert.ok(next.weekday <= 5, 'catch-up must not land on a weekend');
  assert.strictEqual(next.hour, 8, 'hour slot must not drift');
  assert.ok(next > saturday.plus({ days: 120 }), 'must land strictly after the floor');
});
