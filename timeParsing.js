const chrono = require('chrono-node');
const { DateTime } = require('luxon');

// --- Natural language parsing helpers ---
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
  // Ordinal suffixes ("22nd", "1st") must stay attached to their digits or
  // chrono-node loses the day-of-month entirely.
  normalized = normalized.replace(/\s+/g, ' ');
  normalized = normalized.replace(/([a-zA-Z])(\d)/g, '$1 $2');
  normalized = normalized.replace(/(\d)(?!(?:st|nd|rd|th)\b)([a-zA-Z])/gi, '$1 $2');

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
 * Parse the normalized text using chrono-node, taking into account the user's
 * timezone (IST) and adding reasonable defaults if the user omitted any part of
 * the time (for example "next monday" keeps the current time-of-day).
 *
 * @param {string} timeInputRaw - Raw input from the slash command.
 * @param {DateTime} baseIST - Current time in IST, used as reference.
 * @returns {DateTime|null} Parsed DateTime or null if parsing failed.
 */
function parseReminderDateTime(timeInputRaw, baseIST) {
  const normalizedInput = normalizeTimeInput(timeInputRaw);
  if (!normalizedInput) {
    return null;
  }

  const results = chrono.parse(normalizedInput, baseIST.toJSDate(), { forwardDate: true });
  if (!results || results.length === 0) {
    return null;
  }

  const parsedResult = results[0];
  const parsedDate = parsedResult.date();
  const start = parsedResult.start;
  if (!parsedDate) {
    return null;
  }

  if (!start) {
    return null;
  }

  // Chrono omits timezone information for most casual phrases ("tomorrow at 5pm"
  // or "next monday"), which means the Date instance we receive is expressed in
  // the server's local zone (UTC on the bot host). In those cases we must keep the
  // clock time intact when moving into IST. For results that *do* carry a concrete
  // offset (e.g. "in 10 mins", "5pm UTC") we let Luxon shift the instant so that
  // relative phrases remain accurate.
  const keepLocalTime = !start.isCertain('timezoneOffset');
  let dt = DateTime.fromJSDate(parsedDate).setZone('Asia/Kolkata', { keepLocalTime });

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
  } else {
    // If the hour was present but minutes/seconds were not, normalise to :00
    // to avoid ambiguous times such as "at 5" (which chrono interprets as 5:00).
    if (!start.isCertain('minute')) {
      dt = dt.set({ minute: 0, second: 0, millisecond: 0 });
    } else if (!start.isCertain('second')) {
      dt = dt.set({ second: 0, millisecond: 0 });
    }
  }

  return dt;
}

module.exports = { normalizeTimeInput, parseReminderDateTime };
