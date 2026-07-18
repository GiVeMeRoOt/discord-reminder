const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const { normalizeTimeInput, parseReminderDateTime } = require('./timeParsing');

// Fixed reference: Fri 17 Jul 2026, 10:00 IST. Chosen so that "22nd July" is a
// few days ahead but July 1st is already in the past — the exact setup that
// previously made forwardDate skip to the next year.
const baseIST = DateTime.fromISO('2026-07-17T10:00:00', { zone: 'Asia/Kolkata' });

test('keeps ordinal suffixes attached to their digits', () => {
  assert.equal(normalizeTimeInput('On 22nd July'), 'On 22nd July');
  assert.equal(normalizeTimeInput('1st of August'), '1st of August');
  assert.equal(normalizeTimeInput('march 3rd'), 'march 3rd');
  assert.equal(normalizeTimeInput('the 4th at 5pm'), 'the 4th at 5 pm');
});

test('still separates digits glued to regular words', () => {
  assert.equal(normalizeTimeInput('in10mins'), 'in 10 mins');
  assert.equal(normalizeTimeInput('feb18'), 'feb 18');
  assert.equal(normalizeTimeInput('in2hours'), 'in 2 hours');
});

test('parses "On 22nd July" as the upcoming 22nd, not next year', () => {
  const dt = parseReminderDateTime('On 22nd July', baseIST);
  assert.ok(dt, 'expected a parsed DateTime');
  assert.equal(dt.year, 2026);
  assert.equal(dt.month, 7);
  assert.equal(dt.day, 22);
});

test('ordinal dates already past this year roll forward to next year', () => {
  const dt = parseReminderDateTime('On 2nd July', baseIST);
  assert.ok(dt, 'expected a parsed DateTime');
  assert.equal(dt.year, 2027);
  assert.equal(dt.month, 7);
  assert.equal(dt.day, 2);
});

test('ordinal date with explicit time keeps the given hour', () => {
  const dt = parseReminderDateTime('22nd July at 6pm', baseIST);
  assert.ok(dt, 'expected a parsed DateTime');
  assert.equal(dt.year, 2026);
  assert.equal(dt.month, 7);
  assert.equal(dt.day, 22);
  assert.equal(dt.hour, 18);
  assert.equal(dt.minute, 0);
});

test('ordinal date without a time reuses the current time-of-day', () => {
  const dt = parseReminderDateTime('On 22nd July', baseIST);
  assert.ok(dt, 'expected a parsed DateTime');
  assert.equal(dt.hour, baseIST.hour);
  assert.equal(dt.minute, baseIST.minute);
});
