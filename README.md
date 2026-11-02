# discord-reminder

A Discord bot for setting natural‑language reminders. Type something like
`/rme tomorrow at 10am` and the bot pings you when the time comes — with buttons to
snooze or cancel, and optional recurrence (hourly, daily, weekly, and more).

Reminders are persisted by writing them as JSON messages into a dedicated Discord
channel, so the bot needs no external database.

## Features

- **Natural language times** — powered by [`chrono-node`](https://github.com/wanasit/chrono).
  Understands phrases like `at 22:45`, `tomorrow at 10am`, `next monday`, `feb 18th`,
  `in 10 days`, `tonight`, `this evening`, etc.
- **Optional title** — attach a label to the reminder that is shown when it fires.
- **Recurring reminders** — `hourly`, `daily`, `weekday` (Mon–Fri), `weekly`, `monthly`, `yearly`.
- **Snooze buttons** — snooze a fired reminder by 30 minutes, 2 hours, or 1 day.
- **Cancel button** — recurring reminders can be cancelled directly from the message.
- **Delete by ID** — `/delrme <id>` removes a scheduled reminder.
- **Durable storage** — reminders survive restarts; on startup the bot re-reads the
  storage channel and reschedules everything still pending.
- **No database** — reminder state lives entirely in a Discord channel as JSON messages.

## Commands

| Command | Description |
| --- | --- |
| `/rme time:<when> [title:<text>] [repeat:<interval>]` | Set a reminder. `time` is required; `title` and `repeat` are optional. |
| `/delrme id:<reminderId>` | Delete a reminder you own by its ID (shown when the reminder is created). |

`repeat` accepts: `hourly`, `daily`, `weekday`, `weekly`, `monthly`, `yearly`.

### Examples

```
/rme time:in 10 minutes
/rme time:tomorrow at 9am title:Standup
/rme time:at 18:00 title:Take a break repeat:daily
/rme time:next monday title:Weekly review repeat:weekly
```

## How it works

- **Parsing** — user input is lightly normalized (`normalizeTimeInput`) and parsed with
  `chrono-node`, then interpreted in the **IST (`Asia/Kolkata`)** timezone via `luxon`.
  The parse is explicitly anchored to IST (chrono is given the IST offset as its
  reference timezone), so reminders resolve to the same wall-clock time no matter which
  timezone the host process runs in. This logic lives in [`timeParsing.js`](timeParsing.js).
- **Scheduling** — [`node-schedule`](https://github.com/node-schedule/node-schedule)
  holds an in‑memory job per reminder, keyed by reminder ID in a `Map`.
- **Persistence** — each reminder is a JSON message in the storage channel
  (`REMINDER_STORAGE_CHANNEL_ID`). The message ID is cached on the record
  (`storageMessageId`) so lookups are O(1); a paginated scan is the fallback for older
  records that predate that field.
- **Recurrence** — when a recurring reminder fires, its stored record's `remindAt` is
  advanced to the next occurrence and rescheduled. One‑off reminders are marked
  `triggered`.
- **Restart recovery** — on `ready`, the bot scans the storage channel, reschedules
  future reminders, rolls recurring reminders forward past any missed occurrences, and
  cleans up stale one‑offs.

> **Note on timezone:** the bot assumes reminders should be interpreted in **IST
> (`Asia/Kolkata`)**. This is currently hard-coded. See [Known issues](#known-issues).
> It is, however, independent of the *host* timezone — the bot behaves the same on a
> UTC server as on an IST one.

## Setup

### Prerequisites

- Node.js 16.9+ (required by discord.js v14)
- A Discord application + bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A Discord server where the bot is invited with the `applications.commands` scope

### 1. Create a storage channel

Create a text channel the bot can read and write to (e.g. `#reminder-storage`). This is
where reminder JSON is kept. It's best to make it a private/admin-only channel since it
holds raw reminder data. Copy its channel ID (enable Developer Mode in Discord → right‑click
the channel → Copy Channel ID).

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Your bot token. |
| `CLIENT_ID` | Your application's client (application) ID. |
| `REMINDER_STORAGE_CHANNEL_ID` | ID of the channel used to store reminder data. |

Optional tuning variables:

| Variable | Default | Description |
| --- | --- | --- |
| `REMINDER_LOOKUP_MAX_PAGES` | `50` | Max pages (100 messages each) scanned when looking up a reminder that has no cached message ID. |
| `REMINDER_STARTUP_SCAN_MAX_PAGES` | `100` | Max pages scanned on startup when rescheduling pending reminders. |

### 3. Install and run

```bash
npm install
npm start
```

Slash commands are registered globally on startup. Global command propagation can take
up to an hour the first time.

## Deployment

A `Procfile` is included for Heroku-style platforms:

```
worker: node index.js
```

Run it as a **worker** process (there is no web server).

## Project structure

| File | Purpose |
| --- | --- |
| [`index.js`](index.js) | Bot entry point: command registration, scheduling, persistence, and interaction handling. |
| [`timeParsing.js`](timeParsing.js) | Natural-language time parsing (IST-anchored, host-timezone independent). |
| [`timeParsing.test.js`](timeParsing.test.js) | Aggressive tests for the parser, including host-timezone independence. |
| [`recurrence.js`](recurrence.js) | Recurrence arithmetic: next-occurrence resolution and outage catch-up. |
| [`recurrence.test.js`](recurrence.test.js) | Tests for recurrence, including bulk-vs-stepped catch-up parity. |
| [`reminderStorage.js`](reminderStorage.js) | Reads and writes reminder records in the storage channel, and decides who may act on one. |
| [`reminderStorage.test.js`](reminderStorage.test.js) | Tests for lookup, ownership, snooze, rollover, and startup catch-up. |
| [`interactionReplies.js`](interactionReplies.js) | Replies for a button press whose reminder is gone or is not the presser's. |
| [`interactionReplies.test.js`](interactionReplies.test.js) | Tests that a dead button never overwrites the public reminder text. |
| [`lookupPagination.js`](lookupPagination.js) | Helper that normalizes reminder-lookup page limits (preserves explicit "no fallback" caps). |
| [`lookupPagination.test.js`](lookupPagination.test.js) | Tests for the pagination helper. |
| [`.env.example`](.env.example) | Template for required environment variables. |
| [`Procfile`](Procfile) | Worker process definition for deployment. |

## Testing

```bash
npm test        # or: node --test
```

## Known issues

- **Timezone is hard-coded to IST (`Asia/Kolkata`).** Reminders are always parsed and
  fired in IST regardless of the user's actual timezone. The recurrence catch-up in
  [`recurrence.js`](recurrence.js) also assumes that zone is fixed-offset.

- **Monthly recurrence drifts off month ends.** A monthly reminder is advanced one
  month at a time, and `plus({ months: 1 })` clamps to the shortest month it crosses,
  so the day-of-month ratchets permanently downward: "monthly on the 31st" becomes the
  28th and stays there. Fixing it means storing the intended day-of-month and clamping
  per occurrence rather than accumulating the clamp. `yearly` has the same defect for a
  Feb 29 anchor.

- **A press on a stale button costs a full storage-channel scan.** Button custom ids
  carry only the reminder id, so the single-fetch fast path in
  [`reminderStorage.js`](reminderStorage.js) cannot be used and the lookup falls back to
  walking the channel 100 messages at a time. A recurring reminder leaves one
  button-bearing message per occurrence and only the pressed one gets its buttons
  retired, so the other messages stay clickable. Carrying the storage message id in the
  custom id would fix this, and needs a parser that still accepts ids already posted.

- **An unresolvable recurrence record is deleted, not quarantined.** When catch-up
  cannot produce a next occurrence, the startup scan deletes the record. In a
  channel-as-database design that is unrecoverable. Reachable only with an anchor
  decades stale or outside Luxon's range, which no normal flow produces.

> **Fixed:** weekday phrasing on a non‑IST host used to land on the wrong day — e.g. on a
> UTC host, `/rme time:at 8 AM on Monday` sent on a Monday afternoon scheduled for Tuesday.
> The parser now anchors chrono's reference "now" to IST and advances weekday phrases to
> the next matching weekday, so the result is correct and host-timezone independent. This
> is covered by tests in [`timeParsing.test.js`](timeParsing.test.js).

## License

MIT
