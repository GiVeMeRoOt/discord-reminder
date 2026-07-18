const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { DateTime } = require('luxon');

const { normalizeTimeInput, parseReminderDateTime, REMINDER_ZONE } = require('./timeParsing');

// Fixed reference "now": Monday, 13 July 2026, 12:38 PM IST.
// This mirrors the exact scenario from the reported bug and keeps every
// assertion deterministic regardless of the real clock or host timezone.
const BASE_ISO = '2026-07-13T12:38:00';
function baseNow() {
  return DateTime.fromISO(BASE_ISO, { zone: REMINDER_ZONE });
}

// Parse against the fixed base and return a "ccc yyyy-MM-dd HH:mm" string in IST
// (e.g. "Mon 2026-07-20 08:00") so assertions read like a human would expect.
function parseFmt(input) {
  const dt = parseReminderDateTime(input, baseNow());
  return dt ? dt.toFormat('ccc yyyy-MM-dd HH:mm') : null;
}

describe('parseReminderDateTime — reported regression', () => {
  test('"at 8 AM on Monday" on Monday afternoon lands on NEXT Monday, not Tuesday', () => {
    // The original bug scheduled this for Tue 2026-07-14. It must be next Monday.
    assert.equal(parseFmt('at 8 AM on Monday'), 'Mon 2026-07-20 08:00');
  });

  test('the result is never the day after the requested weekday', () => {
    const dt = parseReminderDateTime('at 8 AM on Monday', baseNow());
    assert.equal(dt.weekdayLong, 'Monday');
    assert.notEqual(dt.toFormat('yyyy-MM-dd'), '2026-07-14'); // the buggy Tuesday
  });
});

describe('parseReminderDateTime — weekday phrases', () => {
  test('a later weekday this week resolves within the same week', () => {
    // Tuesday is tomorrow; 8am Tuesday is still in the future.
    assert.equal(parseFmt('at 8 AM on Tuesday'), 'Tue 2026-07-14 08:00');
  });

  test('"friday at 6pm" resolves to this coming Friday', () => {
    assert.equal(parseFmt('friday at 6pm'), 'Fri 2026-07-17 18:00');
  });

  test('bare weekday matching today jumps a full week (weekday-aware fallback)', () => {
    // Today is Monday with no time given -> reuse 12:38, which is now/past,
    // so it must advance 7 days rather than 1.
    assert.equal(parseFmt('monday'), 'Mon 2026-07-20 12:38');
  });

  test('"next monday" keeps the current time-of-day', () => {
    assert.equal(parseFmt('next monday'), 'Mon 2026-07-20 12:38');
  });
});

describe('parseReminderDateTime — explicit times today', () => {
  test('a future time today stays today ("at 5pm")', () => {
    assert.equal(parseFmt('at 5pm'), 'Mon 2026-07-13 17:00');
  });

  test('24h time is respected ("at 22:45")', () => {
    assert.equal(parseFmt('at 22:45'), 'Mon 2026-07-13 22:45');
  });

  test('a past time today rolls to tomorrow ("at 11am" when it is 12:38)', () => {
    assert.equal(parseFmt('at 11am'), 'Tue 2026-07-14 11:00');
  });

  test('bare hour normalises minutes to :00 ("at 5" -> 17:00 not 17:38)', () => {
    // 5 is interpreted as 5am, already past, so it advances a day at 05:00.
    assert.equal(parseFmt('at 5'), 'Tue 2026-07-14 05:00');
  });
});

describe('parseReminderDateTime — relative offsets', () => {
  test('"in 10 minutes"', () => {
    assert.equal(parseFmt('in 10 minutes'), 'Mon 2026-07-13 12:48');
  });

  test('"in 2 hours"', () => {
    assert.equal(parseFmt('in 2 hours'), 'Mon 2026-07-13 14:38');
  });

  test('digit/word glued input is normalised ("in10mins")', () => {
    assert.equal(parseFmt('in10mins'), 'Mon 2026-07-13 12:48');
  });
});

describe('parseReminderDateTime — day/date phrases', () => {
  test('"tomorrow at 10am"', () => {
    assert.equal(parseFmt('tomorrow at 10am'), 'Tue 2026-07-14 10:00');
  });

  test('bare "tomorrow" keeps current time-of-day', () => {
    assert.equal(parseFmt('tomorrow'), 'Tue 2026-07-14 12:38');
  });

  test('"next week" keeps current time-of-day', () => {
    assert.equal(parseFmt('next week'), 'Mon 2026-07-20 12:38');
  });

  test('a calendar date already past this year rolls to next year ("feb 18th")', () => {
    assert.equal(parseFmt('feb 18th'), 'Thu 2027-02-18 12:38');
  });
});

// Regression: the digit/letter spacing rule used to mangle "22nd" into "22 nd",
// so chrono only matched the month and forwardDate pushed a bare "July" to
// July 1st of NEXT year.
describe('parseReminderDateTime — ordinal dates', () => {
  test('"On 22nd July" resolves to the upcoming 22nd, not next year', () => {
    assert.equal(parseFmt('On 22nd July'), 'Wed 2026-07-22 12:38');
  });

  test('an ordinal date already past this year rolls to next year ("On 2nd July")', () => {
    assert.equal(parseFmt('On 2nd July'), 'Fri 2027-07-02 12:38');
  });

  test('ordinal date with an explicit time keeps the given hour', () => {
    assert.equal(parseFmt('22nd July at 6pm'), 'Wed 2026-07-22 18:00');
  });

  test('"1st of August" and "march 3rd" parse as day-of-month', () => {
    assert.equal(parseFmt('1st of August'), 'Sat 2026-08-01 12:38');
    assert.equal(parseFmt('march 3rd'), 'Wed 2027-03-03 12:38');
  });
});

describe('parseReminderDateTime — normalisation shortcuts', () => {
  test('"tonight" maps to 9pm today', () => {
    assert.equal(parseFmt('tonight'), 'Mon 2026-07-13 21:00');
  });

  test('"tomorrow evening" maps to 7pm tomorrow', () => {
    assert.equal(parseFmt('tomorrow evening'), 'Tue 2026-07-14 19:00');
  });

  test('explicit time after a keyword is preserved ("tonight at 11pm")', () => {
    assert.equal(parseFmt('tonight at 11pm'), 'Mon 2026-07-13 23:00');
  });
});

describe('parseReminderDateTime — invalid input', () => {
  for (const bad of [null, undefined, '', '   ', 'asdkjfhaslkdjf', 'purple monkey']) {
    test(`returns null for ${JSON.stringify(bad)}`, () => {
      assert.equal(parseReminderDateTime(bad, baseNow()), null);
    });
  }
});

describe('parseReminderDateTime — always in the future', () => {
  const inputs = [
    'at 8 AM on Monday', 'monday', 'at 11am', 'noon', 'at 5', 'tonight',
    'tomorrow', 'next week', 'in 1 minute', 'friday at 6pm'
  ];
  for (const input of inputs) {
    test(`"${input}" resolves strictly after now`, () => {
      const dt = parseReminderDateTime(input, baseNow());
      assert.ok(dt, `expected a parse for "${input}"`);
      assert.ok(dt > baseNow(), `"${input}" -> ${dt.toISO()} should be after ${BASE_ISO}`);
    });
  }
});

describe('normalizeTimeInput', () => {
  test('collapses whitespace and spaces digit/letter boundaries', () => {
    assert.equal(normalizeTimeInput('in10mins'), 'in 10 mins');
    assert.equal(normalizeTimeInput('feb18'), 'feb 18');
    assert.equal(normalizeTimeInput('  at   22:45  '), 'at 22:45');
  });

  test('keeps ordinal suffixes attached to their digits', () => {
    assert.equal(normalizeTimeInput('On 22nd July'), 'On 22nd July');
    assert.equal(normalizeTimeInput('1st of August'), '1st of August');
    assert.equal(normalizeTimeInput('march 3rd'), 'march 3rd');
    assert.equal(normalizeTimeInput('the 4th at 5pm'), 'the 4th at 5 pm');
  });

  test('maps vague phrases to concrete times', () => {
    assert.equal(normalizeTimeInput('tonight'), 'today at 9pm');
    assert.equal(normalizeTimeInput('tomorrow evening'), 'tomorrow at 7pm');
    assert.equal(normalizeTimeInput('noon'), '12pm');
  });

  test('does not override an explicit time following a vague phrase', () => {
    // The vague word is left intact (not rewritten to a default hour) so the
    // user's explicit time wins; chrono then parses the phrase directly.
    assert.equal(normalizeTimeInput('tonight at 11pm'), 'tonight at 11 pm');
    assert.equal(normalizeTimeInput('tomorrow evening at 8'), 'tomorrow evening at 8');
  });

  test('empty-ish input yields empty string', () => {
    assert.equal(normalizeTimeInput(''), '');
    assert.equal(normalizeTimeInput(null), '');
    assert.equal(normalizeTimeInput(undefined), '');
  });
});

// The whole point of the fix: the parse must be anchored to IST and therefore
// produce identical results no matter what timezone the host process runs in.
// We re-run the reported bug case in child processes under a spread of host
// timezones and assert the output never changes.
describe('parseReminderDateTime — host-timezone independence', () => {
  const modulePath = require.resolve('./timeParsing');
  const luxonPath = require.resolve('luxon');
  const EXPECTED = '2026-07-20T08:00:00.000+05:30';

  const script = [
    `const { parseReminderDateTime } = require(${JSON.stringify(modulePath)});`,
    `const { DateTime } = require(${JSON.stringify(luxonPath)});`,
    `const base = DateTime.fromISO(${JSON.stringify(BASE_ISO)}, { zone: 'Asia/Kolkata' });`,
    `process.stdout.write(parseReminderDateTime('at 8 AM on Monday', base).toISO());`
  ].join('\n');

  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    test(`identical result under TZ=${tz}`, () => {
      const out = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, TZ: tz },
        cwd: path.dirname(modulePath),
        encoding: 'utf8'
      });
      assert.equal(out, EXPECTED);
    });
  }
});
