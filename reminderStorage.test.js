const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const {
  STORAGE_FETCH_PAGE_SIZE,
  parseStoredReminderData,
  fetchStoredReminderMessage,
  forEachStoredReminder,
  backfillStorageMessageId,
  applyRecurrenceRollover,
  applySnooze,
  applyStartupCatchUp,
  REMINDER_ACTION_OUTCOME,
  resolveReminderForActor,
  describeReminderActionFailure
} = require('./reminderStorage');

const ZONE = 'Asia/Kolkata';
const at = (day, hour, minute = 0) =>
  DateTime.fromObject({ year: 2026, month: 7, day, hour, minute }, { zone: ZONE });

/**
 * Minimal stand-in for a discord.js Message. Records every edit/delete so tests
 * can assert on what was actually persisted, not just on return values.
 */
function fakeMessage(id, payload) {
  return {
    id,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    edits: [],
    deleted: false,
    async edit(content) {
      this.content = content;
      this.edits.push(content);
      return this;
    },
    async delete() {
      this.deleted = true;
      return this;
    },
    /** Parsed view of the most recently persisted content. */
    get persisted() {
      return JSON.parse(this.content);
    }
  };
}

/** discord.js returns a Collection; these tests only need size/values/last. */
function collection(messages) {
  return {
    size: messages.length,
    values: () => messages[Symbol.iterator](),
    last: () => messages[messages.length - 1]
  };
}

/**
 * Fake storage channel backed by an ordered page list. Records fetch calls so
 * tests can assert pagination actually walked (or stopped when it should).
 */
function fakeChannel(pages, { byId = {}, textBased = true } = {}) {
  const fetchCalls = [];
  return {
    fetchCalls,
    isTextBased: () => textBased,
    messages: {
      async fetch(arg) {
        if (typeof arg === 'string') {
          fetchCalls.push({ id: arg });
          const msg = byId[arg];
          if (!msg) throw new Error('Unknown Message');
          return msg;
        }
        fetchCalls.push({ before: arg.before, limit: arg.limit });
        const index = arg.before
          ? pages.findIndex(p => p.some(m => m.id === arg.before)) + 1
          : 0;
        return collection(pages[index] || []);
      }
    }
  };
}

const record = (over = {}) => ({
  id: 'r1',
  userId: 'u1',
  channelId: 'c1',
  remindAt: at(27, 8).toISO(),
  title: null,
  recurrence: null,
  triggered: false,
  ...over
});

const daily = over => record({ recurrence: { type: 'daily', anchor: at(27, 8).toISO() }, ...over });

// --- parsing -----------------------------------------------------------------

test('malformed JSON in a storage message is skipped, not thrown', () => {
  assert.strictEqual(parseStoredReminderData(fakeMessage('m1', 'not json {{')), null);
  assert.deepStrictEqual(parseStoredReminderData(fakeMessage('m1', { a: 1 })), { a: 1 });
});

// --- lookup ------------------------------------------------------------------

test('fast path fetches by storageMessageId without paginating', async () => {
  const msg = fakeMessage('m1', record({ storageMessageId: 'm1' }));
  const ch = fakeChannel([], { byId: { m1: msg } });

  const found = await fetchStoredReminderMessage(ch, 'r1', 'u1', { storageMessageId: 'm1' });

  assert.ok(found);
  assert.strictEqual(found.message.id, 'm1');
  assert.deepStrictEqual(ch.fetchCalls, [{ id: 'm1' }], 'must not fall back to a scan');
});

test('falls back to a paginated scan when the id lookup misses', async () => {
  const page1 = Array.from({ length: STORAGE_FETCH_PAGE_SIZE }, (_, i) =>
    fakeMessage(`a${i}`, record({ id: `other${i}` }))
  );
  const page2 = [fakeMessage('b0', record({ id: 'r1' }))];
  const ch = fakeChannel([page1, page2]);

  const found = await fetchStoredReminderMessage(ch, 'r1', 'u1', {});

  assert.ok(found, 'should find the record on the second page');
  assert.strictEqual(found.message.id, 'b0');
  assert.strictEqual(ch.fetchCalls.length, 2, 'should have walked exactly two pages');
});

test('a stale storageMessageId still resolves via the scan fallback', async () => {
  const real = fakeMessage('b0', record({ id: 'r1' }));
  const ch = fakeChannel([[real]], { byId: {} }); // 'gone' id throws

  const found = await fetchStoredReminderMessage(ch, 'r1', 'u1', { storageMessageId: 'gone' });

  assert.ok(found);
  assert.strictEqual(found.message.id, 'b0');
});

test('ownership is enforced on both the fast path and the scan', async () => {
  const mine = record({ userId: 'u1' });
  const msg = fakeMessage('m1', mine);

  const fast = fakeChannel([], { byId: { m1: msg } });
  assert.strictEqual(
    await fetchStoredReminderMessage(fast, 'r1', 'someone-else', { storageMessageId: 'm1' }),
    null,
    'fast path must reject a non-owner'
  );

  const scan = fakeChannel([[fakeMessage('b0', mine)]]);
  assert.strictEqual(
    await fetchStoredReminderMessage(scan, 'r1', 'someone-else', {}),
    null,
    'scan must reject a non-owner'
  );
});

test('maxPages: 0 disables the scan fallback entirely', async () => {
  const ch = fakeChannel([[fakeMessage('b0', record())]]);
  const found = await fetchStoredReminderMessage(ch, 'r1', 'u1', { maxPages: 0 });
  assert.strictEqual(found, null);
  assert.strictEqual(ch.fetchCalls.length, 0, 'no pages should be fetched');
});

test('a non-text channel yields null instead of throwing', async () => {
  const ch = fakeChannel([], { textBased: false });
  assert.strictEqual(await fetchStoredReminderMessage(ch, 'r1', 'u1', {}), null);
});

test('scan skips malformed records and still finds the target', async () => {
  const ch = fakeChannel([[
    fakeMessage('bad', 'not json'),
    fakeMessage('good', record({ id: 'r1' }))
  ]]);
  const found = await fetchStoredReminderMessage(ch, 'r1', 'u1', {});
  assert.strictEqual(found.message.id, 'good');
});

// --- startup scan ------------------------------------------------------------

test('forEachStoredReminder visits every valid record across pages', async () => {
  const page1 = Array.from({ length: STORAGE_FETCH_PAGE_SIZE }, (_, i) =>
    fakeMessage(`a${i}`, record({ id: `r${i}` }))
  );
  const page2 = [fakeMessage('b0', record({ id: 'last' })), fakeMessage('b1', 'garbage')];
  const ch = fakeChannel([page1, page2]);

  const seen = [];
  await forEachStoredReminder(ch, async (_m, data) => { seen.push(data.id); });

  assert.strictEqual(seen.length, STORAGE_FETCH_PAGE_SIZE + 1, 'garbage record must be skipped');
  assert.strictEqual(seen.at(-1), 'last');
});

test('startup scan honours its page cap', async () => {
  const full = n => Array.from({ length: STORAGE_FETCH_PAGE_SIZE }, (_, i) =>
    fakeMessage(`p${n}m${i}`, record({ id: `p${n}r${i}` }))
  );
  const ch = fakeChannel([full(0), full(1), full(2)]);

  const seen = [];
  await forEachStoredReminder(ch, async (_m, d) => { seen.push(d.id); }, { maxPages: 2 });

  assert.strictEqual(ch.fetchCalls.length, 2);
  assert.strictEqual(seen.length, STORAGE_FETCH_PAGE_SIZE * 2);
});

// --- storageMessageId backfill ----------------------------------------------

test('backfill writes the message id exactly once', async () => {
  const msg = fakeMessage('m9', record());
  const stored = { message: msg, data: record() };

  assert.strictEqual(await backfillStorageMessageId(stored), true);
  assert.strictEqual(msg.persisted.storageMessageId, 'm9');

  assert.strictEqual(await backfillStorageMessageId(stored), false, 'second call is a no-op');
  assert.strictEqual(msg.edits.length, 1, 'must not re-write an already-backfilled record');
});

// --- rollover after firing ---------------------------------------------------

test('firing a recurring reminder persists both remindAt and the anchor', async () => {
  const data = daily();
  const msg = fakeMessage('m1', data);

  const res = await applyRecurrenceRollover({ message: msg, data }, at(27, 8).toISO(), at(27, 8));

  assert.strictEqual(res.rescheduled, true);
  assert.strictEqual(msg.persisted.remindAt, at(28, 8).toISO());
  assert.strictEqual(msg.persisted.recurrence.anchor, at(28, 8).toISO());
  assert.strictEqual(msg.persisted.triggered, false);
});

test('firing a one-off reminder marks it triggered and does not reschedule', async () => {
  const data = record();
  const msg = fakeMessage('m1', data);

  const res = await applyRecurrenceRollover({ message: msg, data }, at(27, 8).toISO(), at(27, 8));

  assert.strictEqual(res.rescheduled, false);
  assert.strictEqual(msg.persisted.triggered, true);
});

test('an unsatisfiable recurrence is marked triggered rather than looping', async () => {
  const data = record({ recurrence: { type: 'fortnightly', anchor: at(27, 8).toISO() } });
  const msg = fakeMessage('m1', data);

  const res = await applyRecurrenceRollover({ message: msg, data }, at(27, 8).toISO(), at(27, 8));

  assert.strictEqual(res.rescheduled, false);
  assert.strictEqual(msg.persisted.triggered, true);
});

test('legacy record with no anchor rolls forward from remindAt and gains one', async () => {
  const data = record({ recurrence: { type: 'daily' } }); // no anchor
  const msg = fakeMessage('m1', data);

  await applyRecurrenceRollover({ message: msg, data }, at(27, 8).toISO(), at(27, 8));

  assert.strictEqual(msg.persisted.remindAt, at(28, 8).toISO());
  assert.strictEqual(msg.persisted.recurrence.anchor, at(28, 8).toISO(), 'anchor seeded');
});

// --- snooze ------------------------------------------------------------------

test('snooze persists remindAt but leaves the anchor untouched', async () => {
  const data = daily({ remindAt: at(28, 8).toISO() }); // already rolled forward
  const msg = fakeMessage('m1', data);

  const updated = await applySnooze({ message: msg, data }, at(27, 11, 30).toJSDate());

  assert.strictEqual(updated.remindAt, at(27, 11, 30).toISO());
  assert.strictEqual(msg.persisted.remindAt, at(27, 11, 30).toISO());
  assert.strictEqual(
    msg.persisted.recurrence.anchor,
    at(27, 8).toISO(),
    'the anchor is the whole point — it must survive a snooze'
  );
  assert.strictEqual(msg.persisted.triggered, false);
});

// --- the end-to-end bug, through the storage layer ---------------------------

test('full snooze cycle keeps the 8 AM slot in persisted storage', async () => {
  const data = daily();
  const msg = fakeMessage('m1', data);
  const stored = { message: msg, data };

  // 8 AM fires -> rolls to Jul 28.
  await applyRecurrenceRollover(stored, at(27, 8).toISO(), at(27, 8));
  assert.strictEqual(msg.persisted.recurrence.anchor, at(28, 8).toISO());

  // User snoozes the 8 AM message at 9:30 for two hours.
  const snoozed = await applySnooze({ message: msg, data: msg.persisted }, at(27, 11, 30).toJSDate());
  assert.strictEqual(snoozed.remindAt, at(27, 11, 30).toISO());

  // The snoozed occurrence fires at 11:30 and must NOT consume Jul 28.
  await applyRecurrenceRollover(
    { message: msg, data: msg.persisted },
    at(27, 11, 30).toISO(),
    at(27, 11, 30)
  );
  assert.strictEqual(msg.persisted.remindAt, at(28, 8).toISO(), 'Jul 28 8 AM must survive');
  assert.strictEqual(DateTime.fromISO(msg.persisted.remindAt).setZone(ZONE).hour, 8);
});

// --- startup catch-up --------------------------------------------------------

test('startup catch-up restores the canonical hour after an outage', async () => {
  const data = daily();
  const msg = fakeMessage('m1', data);

  const res = await applyStartupCatchUp(msg, data, at(30, 15));

  assert.strictEqual(res.action, 'rescheduled');
  assert.strictEqual(msg.persisted.remindAt, at(31, 8).toISO());
  assert.strictEqual(msg.persisted.recurrence.anchor, at(31, 8).toISO());
  assert.strictEqual(msg.deleted, false);
});

test('startup catch-up resumes at the anchor when a snooze was missed offline', async () => {
  // Snoozed to 11:30 Jul 27, bot died, restarted Jul 27 18:00 -> Jul 28 8 AM.
  const data = daily({ remindAt: at(27, 11, 30).toISO(), recurrence: { type: 'daily', anchor: at(28, 8).toISO() } });
  const msg = fakeMessage('m1', data);

  await applyStartupCatchUp(msg, data, at(27, 18));

  assert.strictEqual(msg.persisted.remindAt, at(28, 8).toISO());
});

test('startup deletes a one-off reminder whose time has passed', async () => {
  const data = record();
  const msg = fakeMessage('m1', data);

  const res = await applyStartupCatchUp(msg, data, at(28, 9));

  assert.strictEqual(res.action, 'deleted');
  assert.strictEqual(msg.deleted, true);
});

test('startup deletes a recurring record whose pattern is unsatisfiable', async () => {
  const data = record({ recurrence: { type: 'bogus', anchor: at(27, 8).toISO() } });
  const msg = fakeMessage('m1', data);

  const res = await applyStartupCatchUp(msg, data, at(28, 9));

  assert.strictEqual(res.action, 'deleted');
  assert.strictEqual(msg.deleted, true);
});

// --- button actions on reminders that may be gone -----------------------------

test('resolves a reminder for its own owner', async () => {
  const msg = fakeMessage('m1', record({ storageMessageId: 'm1' }));
  const ch = fakeChannel([], { byId: { m1: msg } });

  const res = await resolveReminderForActor(ch, 'r1', 'u1', { storageMessageId: 'm1' });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.FOUND);
  assert.strictEqual(res.stored.message.id, 'm1');
});

test('a record owned by someone else is forbidden, not missing', async () => {
  const msg = fakeMessage('m1', record({ userId: 'owner', storageMessageId: 'm1' }));
  const ch = fakeChannel([[msg]], { byId: { m1: msg } });

  const res = await resolveReminderForActor(ch, 'r1', 'stranger', { storageMessageId: 'm1' });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.FORBIDDEN);
  assert.strictEqual(res.stored, undefined);
});

test('a non-owner is handed nothing it could mutate', async () => {
  // Buttons on a public reminder are visible to the whole channel, so the
  // guarantee has to be server side: a non-owner never receives the storage
  // message, so no handler path can edit or delete the record.
  //
  // This holds only while the storage channel is bot-write-only. Records are
  // plain JSON messages and reminder ids are echoed publicly by /rme, so anyone
  // able to post there could forge a record carrying someone else's reminder id
  // and their own userId. Authorization rests on the record's self-reported
  // userId, which is only as trustworthy as write access to that channel.
  const msg = fakeMessage('m1', daily({ userId: 'owner', storageMessageId: 'm1' }));
  const ch = fakeChannel([[msg]], { byId: { m1: msg } });

  for (const stranger of ['stranger', 'another', '']) {
    const res = await resolveReminderForActor(ch, 'r1', stranger, { maxPages: Infinity });
    assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.FORBIDDEN, `actor ${JSON.stringify(stranger)}`);
    assert.strictEqual(res.stored, undefined, 'no handle on the record');
  }

  assert.deepStrictEqual(msg.edits, [], 'record must never be edited by a non-owner');
  assert.strictEqual(msg.deleted, false, 'record must never be deleted by a non-owner');

  // The reply must also leave the public message alone, buttons included.
  const reply = describeReminderActionFailure(REMINDER_ACTION_OUTCOME.FORBIDDEN, 'cancel');
  assert.strictEqual(reply.retireButtons, false, "a stranger's press must not strip the owner's buttons");
});

test('a deleted record is missing, not forbidden', async () => {
  const ch = fakeChannel([[]]);

  const res = await resolveReminderForActor(ch, 'r1', 'u1', { maxPages: Infinity });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.MISSING);
});

test('a second cancel from an earlier occurrence reports the reminder as finished', async () => {
  // A recurring reminder posts a new message with its own buttons every time it
  // fires, and all of them point at one storage record. Cancelling from the
  // newest message deletes that record; the older messages stay clickable.
  const stored = fakeMessage('m1', daily({ storageMessageId: 'm1' }));
  const live = fakeChannel([[stored]], { byId: { m1: stored } });

  const first = await resolveReminderForActor(live, 'r1', 'u1', { maxPages: Infinity });
  assert.strictEqual(first.outcome, REMINDER_ACTION_OUTCOME.FOUND);
  await first.stored.message.delete();

  // Same reminder id, pressed on an older occurrence, after the record is gone.
  const emptied = fakeChannel([[]]);
  const second = await resolveReminderForActor(emptied, 'r1', 'u1', { maxPages: Infinity });

  assert.strictEqual(second.outcome, REMINDER_ACTION_OUTCOME.MISSING);

  const reply = describeReminderActionFailure(second.outcome, 'cancel');
  assert.strictEqual(reply.retireButtons, true, 'dead buttons should be retired');
  assert.ok(
    !/authorized|authorised/i.test(reply.content),
    'the owner must not be told they lack permission for their own reminder'
  );
  assert.match(reply.content, /no longer active/);
});

test('an ownership failure keeps the buttons and says who may act', () => {
  const reply = describeReminderActionFailure(REMINDER_ACTION_OUTCOME.FORBIDDEN, 'snooze');

  assert.strictEqual(reply.retireButtons, false, 'the owner can still use them');
  assert.match(reply.content, /Only the person who created this reminder can snooze it\./);
});

test('startup keeps an hourly recurring record after a long outage', async () => {
  // The series must survive the outage: before bulk catch-up, 1440 hourly steps
  // exhausted the iteration guard and this record was deleted outright, leaving
  // every already-posted reminder message with buttons pointing at nothing.
  const anchor = at(27, 8).minus({ days: 60 });
  const data = record({
    remindAt: anchor.toISO(),
    recurrence: { type: 'hourly', anchor: anchor.toISO() }
  });
  const msg = fakeMessage('m1', data);

  const res = await applyStartupCatchUp(msg, data, at(27, 8));

  assert.strictEqual(res.action, 'rescheduled');
  assert.strictEqual(msg.deleted, false, 'a long outage must not destroy the series');
  assert.strictEqual(msg.persisted.remindAt, at(27, 9).toISO());
  assert.strictEqual(msg.persisted.recurrence.anchor, at(27, 9).toISO());
});

test('a legacy record with no storageMessageId still resolves for its owner', async () => {
  // resolveReminderForActor looks up without the owner filter, so the scan path
  // has to match on reminder id alone and let the ownership check run afterwards.
  const msg = fakeMessage('m1', record());
  const ch = fakeChannel([[msg]]);

  const res = await resolveReminderForActor(ch, 'r1', 'u1', { maxPages: Infinity });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.FOUND);
  assert.strictEqual(res.stored.message.id, 'm1');
});

test('resolveReminderForActor honours an explicit page cap', async () => {
  // The wrapper must pass its options through: with the fallback disabled the
  // record on page 1 is never reached, so the press reports the reminder gone.
  const msg = fakeMessage('m1', record());
  const ch = fakeChannel([[msg]]);

  const res = await resolveReminderForActor(ch, 'r1', 'u1', { maxPages: 0 });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.MISSING);
  assert.deepStrictEqual(ch.fetchCalls, [], 'a disabled fallback must not fetch');
});

test('an unidentified actor is denied rather than granted owner rights', async () => {
  // This is the only authorization check left on the snooze and cancel paths, so
  // it fails closed. Every caller in index.js passes interaction.user.id, which
  // is always a snowflake string, but a future call-site that omits the actor
  // must be denied instead of quietly receiving a mutable handle on the record.
  const msg = fakeMessage('m1', record({ userId: 'owner', storageMessageId: 'm1' }));
  const ch = fakeChannel([[msg]], { byId: { m1: msg } });

  for (const actor of [undefined, '', null, 0, 12345]) {
    const res = await resolveReminderForActor(ch, 'r1', actor, { storageMessageId: 'm1' });

    assert.strictEqual(
      res.outcome,
      REMINDER_ACTION_OUTCOME.FORBIDDEN,
      `actor ${JSON.stringify(actor)} must not pass as the owner`
    );
    assert.strictEqual(res.stored, undefined, 'no handle for an unidentified actor');
  }

  assert.deepStrictEqual(msg.edits, [], 'record must never be edited');
  assert.strictEqual(msg.deleted, false, 'record must never be deleted');
});

test('a colliding reminder id does not lock the owner out', async () => {
  // Ids are Date.now() strings, so two users who create a reminder in the same
  // millisecond share one. The scan must walk past somebody else's record to
  // reach the actor's own rather than settling for the first id match.
  const theirs = fakeMessage('mA', record({ userId: 'userA' }));
  const ours = fakeMessage('mB', record({ userId: 'userB' }));
  const ch = fakeChannel([[theirs, ours]]);

  const res = await resolveReminderForActor(ch, 'r1', 'userB', { maxPages: Infinity });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.FOUND);
  assert.strictEqual(res.stored.message.id, 'mB', 'must resolve the actor own record');
});

test('a colliding id owned only by someone else is still forbidden', async () => {
  const theirs = fakeMessage('mA', record({ userId: 'userA' }));
  const ch = fakeChannel([[theirs]]);

  const res = await resolveReminderForActor(ch, 'r1', 'userB', { maxPages: Infinity });

  assert.strictEqual(res.outcome, REMINDER_ACTION_OUTCOME.FORBIDDEN);
  assert.strictEqual(res.stored, undefined);
});

test('only a missing record retires the buttons', async () => {
  // An unrecognised outcome is a programming error, and the destructive reading
  // is the dangerous default: it would strip the buttons off a live reminder and
  // tell the owner it had finished. Anything that is not MISSING leaves the
  // public message alone, and nothing but FORBIDDEN mentions permissions.
  for (const outcome of ['weird', undefined, null, 'storage_unavailable']) {
    const reply = describeReminderActionFailure(outcome, 'cancel');

    assert.strictEqual(reply.retireButtons, false, `outcome ${String(outcome)} must not strip buttons`);
    assert.ok(!/Only the person/.test(reply.content), 'must not imply a permission problem');
    assert.ok(!/no longer active/.test(reply.content), 'must not claim the reminder is finished');
  }

  const missing = describeReminderActionFailure(REMINDER_ACTION_OUTCOME.MISSING, 'cancel');
  assert.match(missing.content, /no longer active/);
  assert.strictEqual(missing.retireButtons, true);

  const forbidden = describeReminderActionFailure(REMINDER_ACTION_OUTCOME.FORBIDDEN, 'cancel');
  assert.match(forbidden.content, /Only the person who created this reminder/);
  assert.strictEqual(forbidden.retireButtons, false);
});

test('startup keeps a daily series after an outage longer than the step guard', async () => {
  // 500 daily steps exceed MAX_CATCHUP_ITERATIONS. Before bulk catch-up this
  // record resolved to null and the startup scan deleted it outright.
  const anchor = at(27, 8).minus({ days: 500 });
  const data = record({
    remindAt: anchor.toISO(),
    recurrence: { type: 'daily', anchor: anchor.toISO() }
  });
  const msg = fakeMessage('m1', data);

  const res = await applyStartupCatchUp(msg, data, at(27, 8));

  assert.strictEqual(res.action, 'rescheduled');
  assert.strictEqual(msg.deleted, false, 'a long outage must not destroy the series');
  assert.strictEqual(msg.persisted.remindAt, at(28, 8).toISO());
  assert.strictEqual(msg.persisted.recurrence.anchor, at(28, 8).toISO());
});

test('startup catch-up on a weekday series lands on a weekday', async () => {
  const anchor = at(27, 8).minus({ days: 120 });
  const data = record({
    remindAt: anchor.toISO(),
    recurrence: { type: 'weekday', anchor: anchor.toISO() }
  });
  const msg = fakeMessage('m1', data);

  const res = await applyStartupCatchUp(msg, data, at(27, 8));

  assert.strictEqual(res.action, 'rescheduled');
  assert.strictEqual(msg.deleted, false);
  const next = DateTime.fromISO(msg.persisted.remindAt).setZone(ZONE);
  assert.ok(next.weekday <= 5, 'must not resume on a weekend');
  assert.strictEqual(next.hour, 8, 'hour slot must not drift');
  assert.strictEqual(next.toISO(), at(28, 8).toISO());
});

test('a late-firing hourly occurrence reschedules instead of being marked triggered', async () => {
  // The other way a long gap reaches catch-up: the process was wedged, so the
  // job fires 30 days late. Exhausting the guard here marked the record
  // triggered, which quietly ended the series without deleting it.
  const fired = at(27, 8).minus({ days: 30 });
  const data = record({
    remindAt: fired.toISO(),
    recurrence: { type: 'hourly', anchor: fired.toISO() }
  });
  const msg = fakeMessage('m1', data);

  const res = await applyRecurrenceRollover({ message: msg, data }, fired.toISO(), at(27, 8));

  assert.strictEqual(res.rescheduled, true, 'the series must survive the delay');
  assert.strictEqual(msg.persisted.triggered, false);
  assert.strictEqual(msg.persisted.remindAt, at(27, 9).toISO());
  assert.strictEqual(msg.persisted.recurrence.anchor, at(27, 9).toISO());
});
