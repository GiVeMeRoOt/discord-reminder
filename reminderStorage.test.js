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
  applyStartupCatchUp
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
