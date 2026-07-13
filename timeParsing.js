// timeParsing.js
//
// Natural-language time parsing for reminders, extracted so it can be unit
// tested without a live Discord connection.
//
// All reminders are interpreted in a single fixed timezone (IST / Asia/Kolkata).
// Crucially, the parse is anchored to that zone regardless of the timezone the
// *host process* runs in: we hand chrono-node an explicit reference `timezone`
// (the IST UTC offset in minutes) so that "now" — and therefore forwardDate and
// past/future decisions — are evaluated against IST wall-clock time, not the
// server's local clock (which is UTC on most hosts).
const chrono = require('chrono-node');
const { DateTime } = require('luxon');

// The single timezone in which reminders are interpreted and fired.
const REMINDER_ZONE = 'Asia/Kolkata';

/**
 * Normalize user provided natural language so that chrono-node can parse a wider
 * variety of casual phrases. This function purposely keeps the text friendly while
 * inserting helpful hints (e.g. default hours for "tonight") and spacing digits
 * from words (e.g. "in10" -> "in 10").
 *
 * @param {string} rawInput - The raw string received from the slash command.
 * @returns {string} Sanitized input that chrono-node can understand better.
 */
function normalizeTimeInput(rawInput) {
  if (!rawInput) return '';

  let normalized = rawInput.trim();

  // Collapse multiple spaces and ensure there is always a space between digits
  // and characters so expressions such as "in10mins" or "feb18" are readable.
  normalized = normalized.replace(/\s+/g, ' ');
  normalized = normalized.replace(/([a-zA-Z])(\d)/g, '$1 $2');
  normalized = normalized.replace(/(\d)([a-zA-Z])/g, '$1 $2');

  // Helpful replacements for common natural phrases which chrono does not
  // always interpret as expected.
  const guardedReplacements = [
    { regex: /\btonight\b/gi, replacement: 'today at 9pm' },
    { regex: /\bthis\s+evening\b/gi, replacement: 'today at 7pm' },
    { regex: /\bthis\s+afternoon\b/gi, replacement: 'today at 3pm' },
    { regex: /\bthis\s+morning\b/gi, replacement: 'today at 9am' },
    { regex: /\bthis\s+night\b/gi, replacement: 'today at 9pm' },
    { regex: /\btomorrow\s+morning\b/gi, replacement: 'tomorrow at 9am' },
    { regex: /\btomorrow\s+afternoon\b/gi, replacement: 'tomorrow at 3pm' },
    { regex: /\btomorrow\s+evening\b/gi, replacement: 'tomorrow at 7pm' },
    { regex: /\btomorrow\s+night\b/gi, replacement: 'tomorrow at 9pm' }
  ];

  // Determine whether the substring immediately following a matched natural
  // language phrase already specifies a concrete time (e.g. "at 8pm" or
  // "for 20:30"). In those situations we should not inject our default hour,
  // otherwise we risk overriding the user supplied value.
  const startsWithExplicitTime = (text) => {
    const directTimePattern = /^(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b/i;
    const atOrSymbolTimePattern = /\b(?:at|@)\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b/i;
    const aroundTimePattern = /\b(?:around|about|approximately)\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b/i;
    const forTimePattern = /\bfor\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midnight)\b/i;
    const meridiemOrColonAnywhere = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)|noon|midnight)\b/i;

    let remaining = text.trimStart();
    if (!remaining) {
      return false;
    }

    while (true) {
      remaining = remaining.trimStart();
      if (!remaining) {
        return false;
      }

      const punctuationMatch = remaining.match(/^([,.:@\-?!])/);
      if (punctuationMatch) {
        remaining = remaining.slice(punctuationMatch[0].length);
        continue;
      }

      const connectorMatch = remaining.match(/^(?:and|at|around|about|approximately)\b/i);
      if (connectorMatch) {
        remaining = remaining.slice(connectorMatch[0].length);
        continue;
      }

      const timeMatch = remaining.match(directTimePattern);
      if (timeMatch) {
        const remainder = remaining.slice(timeMatch[0].length);
        if (/^\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i.test(remainder)) {
          remaining = remainder;
          continue;
        }

        return true;
      }

      break;
    }

    if (atOrSymbolTimePattern.test(text)) {
      return true;
    }

    if (aroundTimePattern.test(text)) {
      return true;
    }

    if (forTimePattern.test(text)) {
      return true;
    }

    return meridiemOrColonAnywhere.test(text);
  };

  const applyGuardedReplacement = (input, { regex, replacement }) => {
    const flags = regex.flags || '';
    const globalRegex = new RegExp(regex.source, flags.includes('g') ? flags : `${flags}g`);
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = globalRegex.exec(input)) !== null) {
      const matchStart = match.index;
      const matchEnd = globalRegex.lastIndex;
      const afterMatch = input.slice(matchEnd);

      if (startsWithExplicitTime(afterMatch)) {
        result += input.slice(lastIndex, matchEnd);
      } else {
        result += input.slice(lastIndex, matchStart) + replacement;
      }

      lastIndex = matchEnd;
    }

    return result + input.slice(lastIndex);
  };

  guardedReplacements.forEach(replacement => {
    normalized = applyGuardedReplacement(normalized, replacement);
  });

  // Unambiguous tokens can always be replaced because they already denote a
  // specific time-of-day.
  normalized = normalized.replace(/\bnoon\b/gi, '12pm');
  normalized = normalized.replace(/\bmidnight\b/gi, '12am');

  return normalized.trim();
}

/**
 * Parse the normalized text using chrono-node, taking into account the reminder
 * timezone (IST) and adding reasonable defaults if the user omitted any part of
 * the time (for example "next monday" keeps the current time-of-day).
 *
 * The returned DateTime is guaranteed to be in the future relative to `baseIST`:
 * chrono's `forwardDate` handles most cases, and when the time-of-day defaulting
 * lands us back in the past we advance to the next matching occurrence — a full
 * week for weekday phrases ("monday"), otherwise the next day.
 *
 * @param {string} timeInputRaw - Raw input from the slash command.
 * @param {DateTime} baseIST - Current time in IST, used as reference "now".
 * @returns {DateTime|null} Parsed DateTime (IST) or null if parsing failed.
 */
function parseReminderDateTime(timeInputRaw, baseIST) {
  const normalizedInput = normalizeTimeInput(timeInputRaw);
  if (!normalizedInput) {
    return null;
  }

  // Anchor chrono to IST rather than the host's local clock. Passing the
  // reference `timezone` (IST offset in minutes, e.g. 330) means chrono treats
  // "now" as IST wall-clock time and stamps offset-less phrases (e.g. "at 8am")
  // with the IST offset. Without this, a host running in UTC would consider a
  // time that is already past in IST to still be in the future, scheduling the
  // reminder on the wrong day.
  const results = chrono.parse(
    normalizedInput,
    { instant: baseIST.toJSDate(), timezone: baseIST.offset },
    { forwardDate: true }
  );
  if (!results || results.length === 0) {
    return null;
  }

  const parsedResult = results[0];
  const parsedDate = parsedResult.date();
  const start = parsedResult.start;
  if (!parsedDate || !start) {
    return null;
  }

  // Because the parse is anchored to IST, the produced instant already reflects
  // IST wall-clock time; convert straight into the reminder zone.
  let dt = DateTime.fromJSDate(parsedDate).setZone(REMINDER_ZONE);

  // Use chrono certainty flags to determine whether the user explicitly
  // provided the time components. If not, reuse the current IST time-of-day so
  // commands such as "next week" or "on Friday" fire at the same hour.
  if (!start.isCertain('hour')) {
    dt = dt.set({
      hour: baseIST.hour,
      minute: baseIST.minute,
      second: baseIST.second,
      millisecond: baseIST.millisecond
    });
  } else if (!start.isCertain('minute')) {
    // If the hour was present but minutes/seconds were not, normalise to :00
    // to avoid ambiguous times such as "at 5" (which chrono interprets as 5:00).
    dt = dt.set({ minute: 0, second: 0, millisecond: 0 });
  } else if (!start.isCertain('second')) {
    dt = dt.set({ second: 0, millisecond: 0 });
  }

  // Defensive forward adjustment: forwardDate keeps chrono's own output in the
  // future, but reusing the base time-of-day above can push a same-day result
  // back into the past. Advance to the next sensible occurrence — a full week
  // when the user named a weekday, otherwise the next day.
  if (dt <= baseIST) {
    dt = start.isCertain('weekday') ? dt.plus({ days: 7 }) : dt.plus({ days: 1 });
  }

  return dt;
}

module.exports = { REMINDER_ZONE, normalizeTimeInput, parseReminderDateTime };
