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

  const { storageMessageId, maxPages = MAX_LOOKUP_PAGES } = options;
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
  while (pagesFetched < pageLimit) {
    const messages = await storageChannel.messages.fetch({ limit: STORAGE_FETCH_PAGE_SIZE, before });
    if (messages.size === 0) {
      break;
    }

    for (const message of messages.values()) {
      const data = parseStoredReminderData(message);
      if (!data) {
        continue;
      }

      if (data.id === reminderId && (!expectedUserId || data.userId === expectedUserId)) {
        return { message, data };
      }
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

  return null;
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
  applyStartupCatchUp
};
