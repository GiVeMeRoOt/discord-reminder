const { DateTime } = require('luxon');
const { normalizeLookupPageLimit } = require('./lookupPagination');
const { REMINDER_ZONE } = require('./timeParsing');
const { computeNextRecurrence, resolveRecurrenceFloor } = require('./recurrence');

const STORAGE_FETCH_PAGE_SIZE = 100;
const MAX_LOOKUP_PAGES = Number.parseInt(process.env.REMINDER_LOOKUP_MAX_PAGES || '50', 10);
const MAX_STARTUP_SCAN_PAGES = Number.parseInt(process.env.REMINDER_STARTUP_SCAN_MAX_PAGES || '100', 10);

/**
 * Parse JSON payloads from storage messages and return null on invalid payloads.
 *
 * @param {import('discord.js').Message} message
 * @returns {object|null}
 */
function parseStoredReminderData(message) {
  try {
    return JSON.parse(message.content);
  } catch (err) {
    return null;
  }
}

/**
 * Fetch a storage message by id, parse it and optionally assert owner/reminder id.
 *
 * @param {import('discord.js').TextBasedChannel} storageChannel
 * @param {string} messageId
 * @param {string} reminderId
 * @param {string} [expectedUserId]
 * @returns {Promise<{ message: import('discord.js').Message, data: object } | null>}
 */
async function fetchStoredReminderByMessageId(storageChannel, messageId, reminderId, expectedUserId) {
  if (!messageId) {
    return null;
  }

  try {
    const message = await storageChannel.messages.fetch(messageId);
    const data = parseStoredReminderData(message);
    if (!data || data.id !== reminderId) {
      return null;
    }
    if (expectedUserId && data.userId !== expectedUserId) {
      return null;
    }
    return { message, data };
  } catch (err) {
    return null;
  }
}

/**
 * Locate the backing storage message for a reminder.
 *
 * @param {import('discord.js').TextBasedChannel} storageChannel - Channel that stores reminders.
 * @param {string} reminderId - The reminder identifier to look up.
 * @param {string} [expectedUserId] - Optional user ID to enforce ownership.
 * @param {{ storageMessageId?: string, maxPages?: number }} [options]
 * @returns {Promise<{ message: import('discord.js').Message, data: object } | null>}
 */
async function fetchStoredReminderMessage(storageChannel, reminderId, expectedUserId, options = {}) {
  if (!storageChannel || !storageChannel.isTextBased()) {
    return null;
  }

  const { storageMessageId, maxPages = MAX_LOOKUP_PAGES, preferUserId } = options;
  // Preserve explicit caps like 0/NaN as "no paginated fallback" instead of unbounded scan.
  const pageLimit = normalizeLookupPageLimit(maxPages, MAX_LOOKUP_PAGES);

  // Fast path for new reminders: directly fetch by the known storage message id.
  const byMessageId = await fetchStoredReminderByMessageId(
    storageChannel,
    storageMessageId,
    reminderId,
    expectedUserId
  );
  if (byMessageId) {
    return byMessageId;
  }

  // Fallback for old reminders that don't have storageMessageId persisted yet.
  let before;
  let pagesFetched = 0;
  // Holds an id match owned by somebody else while the scan keeps looking for
  // `preferUserId`'s own record. See the comment at the match below.
  let otherOwnerMatch = null;
  while (pagesFetched < pageLimit) {
    const messages = await storageChannel.messages.fetch({ limit: STORAGE_FETCH_PAGE_SIZE, before });
    if (messages.size === 0) {
      break;
    }

    for (const message of messages.values()) {
      const data = parseStoredReminderData(message);
      if (!data || data.id !== reminderId) {
        continue;
      }
      if (expectedUserId && data.userId !== expectedUserId) {
        continue;
      }

      // Reminder ids are millisecond timestamps, so two users who create a
      // reminder in the same millisecond share one. When the caller named a
      // preferred owner, keep scanning past somebody else's record rather than
      // locking the real owner out of their own reminder.
      if (!preferUserId || data.userId === preferUserId) {
        return { message, data };
      }
      otherOwnerMatch = otherOwnerMatch || { message, data };
    }

    pagesFetched += 1;
    before = messages.last()?.id;
    if (!before || messages.size < STORAGE_FETCH_PAGE_SIZE) {
      break;
    }
  }

  if (Number.isFinite(pageLimit) && pagesFetched >= pageLimit) {
    console.warn(`Stopped reminder lookup for ${reminderId} after ${pageLimit} pages.`);
  }

  return otherOwnerMatch;
}

/**
 * Iterate through JSON reminder payloads stored in the storage channel.
 * The scan is paginated and capped to protect startup from excessive history.
 *
 * @param {import('discord.js').TextBasedChannel} storageChannel
 * @param {(message: import('discord.js').Message, data: object) => Promise<void>} visitor
 * @param {{ maxPages?: number }} [options]
 * @returns {Promise<void>}
 */
async function forEachStoredReminder(storageChannel, visitor, options = {}) {
  if (!storageChannel || !storageChannel.isTextBased()) {
    return;
  }

  const { maxPages = MAX_STARTUP_SCAN_PAGES } = options;

  let before;
  let pagesFetched = 0;
  while (pagesFetched < maxPages) {
    const messages = await storageChannel.messages.fetch({ limit: STORAGE_FETCH_PAGE_SIZE, before });
    if (messages.size === 0) {
      return;
    }

    for (const message of messages.values()) {
      const data = parseStoredReminderData(message);
      if (!data) {
        continue;
      }

      await visitor(message, data);
    }

    pagesFetched += 1;
    before = messages.last()?.id;
    if (!before || messages.size < STORAGE_FETCH_PAGE_SIZE) {
      return;
    }
  }

  console.warn(`Stopped startup reminder scan after ${maxPages} pages.`);
}

/**
 * Persist the storage message id onto a record that predates the fast-path
 * lookup, so subsequent lookups are O(1) instead of a paginated scan.
 *
 * @param {{ message: object, data: object }} storedReminder
 * @returns {Promise<boolean>} Whether a write was performed.
 */
async function backfillStorageMessageId(storedReminder) {
  const { message, data } = storedReminder;
  if (data.storageMessageId) {
    return false;
  }
  data.storageMessageId = message.id;
  await message.edit(JSON.stringify(data));
  return true;
}

/**
 * Roll a reminder's storage record forward after an occurrence has fired.
 *
 * For recurring reminders the next occurrence is derived from the recurrence
 * anchor rather than the fired `remindAt`, so a snoozed occurrence cannot drag
 * the series off its canonical slot. When no further occurrence can be produced
 * (or the reminder is one-off) the record is simply marked as triggered.
 *
 * @param {{ message: object, data: object }} storedReminder
 * @param {string} firedRemindAt - ISO instant of the occurrence that just fired.
 * @param {DateTime} [nowIST] - Injectable clock, defaults to now in IST.
 * @returns {Promise<{ rescheduled: boolean, data: object }>}
 */
async function applyRecurrenceRollover(storedReminder, firedRemindAt, nowIST = DateTime.now().setZone(REMINDER_ZONE)) {
  const currentData = storedReminder.data;
  const recurrenceType = currentData?.recurrence?.type;

  if (recurrenceType) {
    // Fall back to remindAt for records created before anchors were tracked.
    const anchorISO = currentData.recurrence.anchor || firedRemindAt;
    const afterIST = resolveRecurrenceFloor(firedRemindAt, nowIST);
    const nextIST = computeNextRecurrence(anchorISO, recurrenceType, afterIST);

    if (nextIST) {
      currentData.remindAt = nextIST.toISO();
      currentData.recurrence.anchor = nextIST.toISO();
      currentData.triggered = false;
      await storedReminder.message.edit(JSON.stringify(currentData));
      return { rescheduled: true, data: currentData };
    }
  }

  currentData.triggered = true;
  await storedReminder.message.edit(JSON.stringify(currentData));
  return { rescheduled: false, data: currentData };
}

/**
 * Move a single occurrence without disturbing the recurrence anchor.
 *
 * Only `remindAt` changes: the anchor stays put so the underlying schedule keeps
 * its canonical slot once the snoozed occurrence has passed.
 *
 * @param {{ message: object, data: object }} storedReminder
 * @param {Date} snoozeUntil - Absolute instant the reminder should re-fire.
 * @returns {Promise<object>} The persisted record.
 */
async function applySnooze(storedReminder, snoozeUntil) {
  const updated = { ...storedReminder.data };
  // Preserve the exact snooze instant while serialising with the IST offset.
  updated.remindAt = DateTime.fromJSDate(snoozeUntil).setZone(REMINDER_ZONE).toISO();
  updated.triggered = false;
  await storedReminder.message.edit(JSON.stringify(updated));
  return updated;
}

/**
 * Decide what to do with a stored record whose time has already passed at startup.
 *
 * Recurring records are caught up from their anchor so the canonical time of day
 * survives an outage; anything that cannot be caught up is dropped.
 *
 * @param {object} message - Storage message.
 * @param {object} data - Parsed record.
 * @param {DateTime} [nowIST] - Injectable clock, defaults to now in IST.
 * @returns {Promise<{ action: 'rescheduled'|'deleted', data?: object }>}
 */
async function applyStartupCatchUp(message, data, nowIST = DateTime.now().setZone(REMINDER_ZONE)) {
  const recurrenceType = data?.recurrence?.type;
  if (recurrenceType) {
    // Fall back to remindAt for records created before anchors were tracked.
    const anchorISO = data.recurrence.anchor || data.remindAt;
    const nextIST = computeNextRecurrence(anchorISO, recurrenceType, nowIST);

    if (nextIST) {
      data.remindAt = nextIST.toISO();
      data.recurrence.anchor = nextIST.toISO();
      await message.edit(JSON.stringify(data));
      return { action: 'rescheduled', data };
    }
  }

  await message.delete();
  return { action: 'deleted' };
}

/**
 * Outcomes for a reminder action requested from a button press.
 *
 * `missing` means no storage record exists any more; `forbidden` means a record
 * exists but belongs to somebody else. Collapsing the two, which is what a plain
 * owner-filtered lookup does, makes a finished reminder look like a permission
 * problem to its own owner.
 */
const REMINDER_ACTION_OUTCOME = {
  FOUND: 'found',
  MISSING: 'missing',
  FORBIDDEN: 'forbidden'
};

/**
 * Resolve the storage record behind a reminder action, keeping "gone" and
 * "not yours" apart.
 *
 * @param {import('discord.js').TextBasedChannel} storageChannel
 * @param {string} reminderId
 * @param {string} actorUserId - The user who pressed the button.
 * @param {{ storageMessageId?: string, maxPages?: number }} [options]
 * @returns {Promise<{ outcome: string, stored?: { message: object, data: object } }>}
 */
async function resolveReminderForActor(storageChannel, reminderId, actorUserId, options = {}) {
  // Fail closed. This function is the only authorization check left on the
  // snooze and cancel paths, so an unidentified caller is denied rather than
  // quietly handed owner rights over somebody else's record.
  if (typeof actorUserId !== 'string' || !actorUserId) {
    return { outcome: REMINDER_ACTION_OUTCOME.FORBIDDEN };
  }

  // Looked up without the owner filter on purpose, so an ownership mismatch stays
  // distinguishable from a record that no longer exists. `preferUserId` keeps the
  // owner-first behaviour of the old filtered lookup when ids collide.
  const stored = await fetchStoredReminderMessage(storageChannel, reminderId, undefined, {
    ...options,
    preferUserId: actorUserId
  });
  if (!stored) {
    return { outcome: REMINDER_ACTION_OUTCOME.MISSING };
  }
  // Compared strictly: a record whose userId is missing, null or a number fails
  // closed instead of coercing its way into a match.
  if (stored.data.userId !== actorUserId) {
    return { outcome: REMINDER_ACTION_OUTCOME.FORBIDDEN };
  }
  return { outcome: REMINDER_ACTION_OUTCOME.FOUND, stored };
}

/**
 * Build the reply for a reminder action that could not be carried out.
 *
 * A recurring reminder posts a fresh message with its own buttons on every
 * occurrence, and all of them point at a single storage record. Once that record
 * is gone, every older message still shows live buttons, so the reply has to say
 * the reminder is finished instead of hinting at a permission problem, and those
 * dead buttons are worth retiring.
 *
 * @param {string} outcome - A non-`found` REMINDER_ACTION_OUTCOME value.
 * @param {string} action - Verb for the attempted action, e.g. 'cancel'.
 * @returns {{ content: string, retireButtons: boolean }}
 */
function describeReminderActionFailure(outcome, action) {
  if (outcome === REMINDER_ACTION_OUTCOME.FORBIDDEN) {
    return {
      content: `Only the person who created this reminder can ${action} it.`,
      retireButtons: false
    };
  }

  if (outcome === REMINDER_ACTION_OUTCOME.MISSING) {
    return {
      content: `That reminder is no longer active, so there is nothing to ${action}. `
        + 'It was already cancelled or deleted, or it has run its course.',
      retireButtons: true
    };
  }

  // Any other value is a programming error. Claim nothing about permissions and
  // leave the message alone: stripping the buttons off a live reminder on the
  // strength of an unrecognised outcome is the more destructive mistake.
  console.error(`Unrecognised reminder action outcome: ${String(outcome)}`);
  return {
    content: 'Something went wrong, so that reminder was left unchanged. Please try again.',
    retireButtons: false
  };
}

module.exports = {
  STORAGE_FETCH_PAGE_SIZE,
  MAX_LOOKUP_PAGES,
  MAX_STARTUP_SCAN_PAGES,
  parseStoredReminderData,
  fetchStoredReminderByMessageId,
  fetchStoredReminderMessage,
  forEachStoredReminder,
  backfillStorageMessageId,
  applyRecurrenceRollover,
  applySnooze,
  applyStartupCatchUp,
  REMINDER_ACTION_OUTCOME,
  resolveReminderForActor,
  describeReminderActionFailure
};
