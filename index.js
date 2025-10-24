// index.js
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const schedule = require('node-schedule');
const chrono = require('chrono-node');
const { DateTime } = require('luxon');
require('dotenv').config();

// Global map to store scheduled jobs (key: reminder id, value: job object)
const scheduledJobs = new Map();

/**
 * Cancel and remove any existing scheduled job for the provided reminder ID.
 * A thin wrapper keeps call-sites concise and guards against missing jobs.
 *
 * @param {string} reminderId - The reminder identifier whose job should stop.
 */
function cancelScheduledJob(reminderId) {
  const existingJob = scheduledJobs.get(reminderId);
  if (existingJob && typeof existingJob.cancel === 'function') {
    existingJob.cancel();
  }
  scheduledJobs.delete(reminderId);
}

/**
 * Locate the backing storage message for a reminder.
 *
 * @param {import('discord.js').TextBasedChannel} storageChannel - Channel that stores reminders.
 * @param {string} reminderId - The reminder identifier to look up.
 * @param {string} [expectedUserId] - Optional user ID to enforce ownership.
 * @returns {Promise<{ message: import('discord.js').Message, data: object } | null>}
 */
async function fetchStoredReminderMessage(storageChannel, reminderId, expectedUserId) {
  if (!storageChannel || !storageChannel.isTextBased()) {
    return null;
  }

  const messages = await storageChannel.messages.fetch({ limit: 100 });
  for (const message of messages.values()) {
    try {
      const data = JSON.parse(message.content);
      if (data.id === reminderId && (!expectedUserId || data.userId === expectedUserId)) {
        return { message, data };
      }
    } catch (err) {
      // Ignore messages that are not JSON payloads managed by the bot.
      continue;
    }
  }

  return null;
}

/**
 * Provide a short human-readable description for a snooze duration.
 * Currently normalises the set of preset snooze button durations.
 *
 * @param {number} durationMs - Snooze length in milliseconds.
 * @returns {string}
 */
function describeSnoozeDuration(durationMs) {
  const minutes = Math.round(durationMs / 60000);
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

// The ID of the channel where reminder data is stored (from .env)
const STORAGE_CHANNEL_ID = process.env.REMINDER_STORAGE_CHANNEL_ID;

// Create a new Discord client instance with guild intents
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Slash Command Registration ---
// /rme command accepts a required "time" option and an optional "title" option.
// /delrme command deletes a reminder by its ID.
const commands = [
  new SlashCommandBuilder()
    .setName('rme')
    .setDescription('Set a reminder (e.g. "/rme at 22:45" or "/rme tomorrow at 10am")')
    .addStringOption(option =>
      option.setName('time')
            .setDescription('When to be reminded (e.g. "at 22:45", "tomorrow at 10am", "feb 18th", "in10 days")')
            .setRequired(true))
    .addStringOption(option =>
      option.setName('title')
            .setDescription('Optional title for the reminder')
            .setRequired(false))
    .addStringOption(option =>
      option.setName('repeat')
            .setDescription('Repeat interval for the reminder')
            .setRequired(false)
            .addChoices(
              { name: 'Every hour', value: 'hourly' },
              { name: 'Every day', value: 'daily' },
              { name: 'Weekdays (Mon-Fri)', value: 'weekday' },
              { name: 'Every week', value: 'weekly' },
              { name: 'Every month', value: 'monthly' },
              { name: 'Every year', value: 'yearly' }
            )),
  new SlashCommandBuilder()
    .setName('delrme')
    .setDescription('Delete a reminder by its ID')
    .addStringOption(option =>
      option.setName('id')
            .setDescription('The reminder ID to delete')
            .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log('Refreshing slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands reloaded.');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
})();

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

/**
 * Describe a recurrence pattern in a user friendly manner for acknowledgement
 * messages and logs.
 *
 * @param {string} recurrenceType - The recurrence identifier.
 * @returns {string} Human readable description.
 */
function describeRecurrence(recurrenceType) {
  switch (recurrenceType) {
    case 'hourly':
      return 'every hour';
    case 'daily':
      return 'every day';
    case 'weekday':
      return 'every weekday';
    case 'weekly':
      return 'every week';
    case 'monthly':
      return 'every month';
    case 'yearly':
      return 'every year';
    default:
      return 'on a repeating schedule';
  }
}

/**
 * Compute the next DateTime (in IST) for a given recurrence pattern.
 *
 * @param {DateTime} currentIST - The current scheduled DateTime in IST.
 * @param {string} recurrenceType - Recurrence identifier.
 * @returns {DateTime|null} The next scheduled time or null when not possible.
 */
function getNextRecurrenceDateTime(currentIST, recurrenceType) {
  if (!currentIST || !currentIST.isValid) {
    return null;
  }

  switch (recurrenceType) {
    case 'hourly':
      return currentIST.plus({ hours: 1 });
    case 'daily':
      return currentIST.plus({ days: 1 });
    case 'weekday': {
      let next = currentIST.plus({ days: 1 });
      let guard = 0;
      while (next.weekday > 5) {
        next = next.plus({ days: 1 });
        guard += 1;
        if (guard > 7) {
          return null;
        }
      }
      return next;
    }
    case 'weekly':
      return currentIST.plus({ weeks: 1 });
    case 'monthly':
      return currentIST.plus({ months: 1 });
    case 'yearly':
      return currentIST.plus({ years: 1 });
    default:
      return null;
  }
}

// --- Helper: Schedule a Reminder ---
// Reminder object: { id, userId, channelId, remindAt (ISO string), title (optional) }
function scheduleReminder(reminder) {
  try {
    if (!reminder || !reminder.remindAt) {
      return;
    }
    const remindAt = new Date(reminder.remindAt);
    if (Number.isNaN(remindAt.getTime())) {
      console.error(`Invalid reminder time for reminder ${reminder.id}`);
      return;
    }
    if (remindAt <= new Date()) return; // Do not schedule if time has passed

    cancelScheduledJob(reminder.id);

    const job = schedule.scheduleJob(remindAt, async function () {
      scheduledJobs.delete(reminder.id);
      try {
        const channel = await client.channels.fetch(reminder.channelId);
        if (!channel) {
          console.error(`Channel ${reminder.channelId} not found for reminder ${reminder.id}`);
          return;
        }
        let reminderText = reminder.title ? `Reminder: **${reminder.title}**` : "Reminder: It's time!";
        
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`snooze_30_${reminder.id}`)
              .setLabel('Snooze 30 mins')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`snooze_120_${reminder.id}`)
              .setLabel('Snooze 2 hours')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`snooze_1440_${reminder.id}`)
              .setLabel('Snooze 1 day')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`cancel_${reminder.id}`)
              .setLabel('Cancel reminder')
              .setStyle(ButtonStyle.Danger)
          );
        
        await channel.send({
          content: `<@${reminder.userId}> ${reminderText}`,
          components: [row]
        });

        // Update storage message to mark as triggered.
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (storageChannel && storageChannel.isTextBased()) {
          const messages = await storageChannel.messages.fetch({ limit: 100 });
          const storageMessage = messages.find(m => {
            try {
              const data = JSON.parse(m.content);
              return data.id === reminder.id;
            } catch (e) {
              return false;
            }
          });
          if (storageMessage) {
            const currentData = JSON.parse(storageMessage.content);
            const recurrenceType = currentData?.recurrence?.type;
            if (recurrenceType) {
              let nextIST = DateTime.fromISO(reminder.remindAt).setZone('Asia/Kolkata');
              let iterations = 0;
              const nowIST = DateTime.now().setZone('Asia/Kolkata');

              do {
                nextIST = getNextRecurrenceDateTime(nextIST, recurrenceType);
                iterations += 1;
                if (!nextIST) {
                  break;
                }
              } while (nextIST <= nowIST && iterations < 400);

              if (nextIST && iterations < 400) {
                currentData.remindAt = nextIST.toISO();
                currentData.triggered = false;
                await storageMessage.edit(JSON.stringify(currentData));
                scheduleReminder(currentData);
              } else {
                currentData.triggered = true;
                await storageMessage.edit(JSON.stringify(currentData));
              }
            } else {
              currentData.triggered = true;
              await storageMessage.edit(JSON.stringify(currentData));
            }
          }
        }
      } catch (err) {
        console.error(`Error sending reminder ${reminder.id}:`, err);
      }
    });
    scheduledJobs.set(reminder.id, job);
  } catch (err) {
    console.error(`Error scheduling reminder ${reminder.id}:`, err);
  }
}

// --- On Bot Startup: Reschedule Pending Reminders ---
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    if (!storageChannel || !storageChannel.isTextBased()) {
      console.error('Storage channel not found or is not text-based.');
      return;
    }
    const messages = await storageChannel.messages.fetch({ limit: 100 });
    messages.forEach(message => {
      try {
        const data = JSON.parse(message.content);
        const remindAt = new Date(data.remindAt);
        if (remindAt > new Date()) {
          scheduleReminder(data);
        } else if (data?.recurrence?.type) {
          let nextIST = DateTime.fromISO(data.remindAt).setZone('Asia/Kolkata');
          const nowIST = DateTime.now().setZone('Asia/Kolkata');
          let iterations = 0;

          do {
            nextIST = getNextRecurrenceDateTime(nextIST, data.recurrence.type);
            iterations += 1;
            if (!nextIST) {
              break;
            }
          } while (nextIST <= nowIST && iterations < 400);

          if (nextIST && iterations < 400) {
            data.remindAt = nextIST.toISO();
            message.edit(JSON.stringify(data)).catch(console.error);
            scheduleReminder(data);
          } else {
            message.delete().catch(console.error);
          }
        } else {
          message.delete().catch(console.error);
        }
      } catch (err) {
        console.error('Error parsing storage message:', err);
      }
    });
  } catch (err) {
    console.error('Error fetching reminders from storage channel:', err);
  }
});

// --- Handle Slash Commands and Button Interactions ---
client.on('interactionCreate', async interaction => {
  if (interaction.isCommand()) {
    if (interaction.commandName === 'rme') {
      try {
        const timeInputRaw = interaction.options.getString('time');
        const title = interaction.options.getString('title'); // optional title
        const repeat = interaction.options.getString('repeat');

        // Create a base reference in IST and attempt to parse the natural language input.
        const baseIST = DateTime.now().setZone('Asia/Kolkata');
        let dt = parseReminderDateTime(timeInputRaw, baseIST);
        if (!dt) {
          await interaction.reply({ content: 'Sorry, I could not understand that time. Please try a different format.', ephemeral: true });
          return;
        }
        // If the resulting time is still before now (in IST), adjust by adding one day
        // so vague phrases such as "today evening" still occur in the future.
        if (dt <= baseIST) {
          dt = dt.plus({ days: 1 });
        }

        const finalISTDate = dt.toJSDate();
        if (finalISTDate <= new Date()) {
          await interaction.reply({ content: 'The time specified is in the past. Please enter a future time.', ephemeral: true });
          return;
        }
        
        // Generate a unique reminder ID.
        const reminderId = Date.now().toString();
        const reminderData = {
          id: reminderId,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          // Store the reminder time as the ISO string with the IST offset.
          remindAt: dt.toISO(),
          title: title || null,
          recurrence: repeat ? { type: repeat } : null,
          triggered: false
        };

        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available. Cannot set reminder.', ephemeral: true });
          return;
        }
        await storageChannel.send(JSON.stringify(reminderData));
        scheduleReminder(reminderData);

        // Acknowledge the reminder. If a title is provided, include it in the acknowledgement.
        let ackMsg = `Alright, <@${interaction.user.id}>, I will remind you <t:${Math.floor(finalISTDate.getTime()/1000)}:R>. (Reminder ID: \`${reminderId}\`)`;
        if (title) {
          ackMsg = `Alright, <@${interaction.user.id}>, I will remind you about **${title}** <t:${Math.floor(finalISTDate.getTime()/1000)}:R>. (Reminder ID: \`${reminderId}\`)`;
        }
        if (repeat) {
          ackMsg += ` This reminder will repeat ${describeRecurrence(repeat)}.`;
        }
        await interaction.reply(ackMsg);
      } catch (err) {
        console.error('Error handling /rme command:', err);
        try {
          await interaction.reply({ content: 'An error occurred while setting your reminder. Please try again later.', ephemeral: true });
        } catch (replyErr) {
          console.error('Error sending error reply:', replyErr);
        }
      }
    } else if (interaction.commandName === 'delrme') {
      try {
        const reminderId = interaction.options.getString('id').trim();
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available. Cannot delete reminder.', ephemeral: true });
          return;
        }
        const storedReminder = await fetchStoredReminderMessage(storageChannel, reminderId, interaction.user.id);
        if (!storedReminder) {
          await interaction.reply({ content: `No reminder found with ID \`${reminderId}\` for you.`, ephemeral: true });
          return;
        }
        cancelScheduledJob(reminderId);
        await storedReminder.message.delete();
        await interaction.reply({ content: `Your reminder with ID \`${reminderId}\` has been deleted.`, ephemeral: true });
      } catch (err) {
        console.error('Error handling /delrme command:', err);
        try {
          await interaction.reply({ content: 'An error occurred while deleting your reminder. Please try again later.', ephemeral: true });
        } catch (replyErr) {
          console.error('Error sending error reply:', replyErr);
        }
      }
    }
  } else if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith('snooze_')) {
      const parts = customId.split('_'); // e.g. ["snooze", "30", "reminderId"]
      let snoozeTimeMs = 0;
      if (parts[1].endsWith('s')) {
        snoozeTimeMs = parseInt(parts[1].slice(0, -1), 10) * 1000;
      } else {
        snoozeTimeMs = parseInt(parts[1], 10) * 60000;
      }
      const reminderId = parts.slice(2).join('_');
      try {
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available.', ephemeral: true });
          return;
        }
        const storedReminder = await fetchStoredReminderMessage(storageChannel, reminderId, interaction.user.id);
        if (!storedReminder) {
          await interaction.reply({ content: 'This reminder no longer exists or you are not authorized to snooze it.', ephemeral: true });
          return;
        }
        const newDate = new Date(Date.now() + snoozeTimeMs);
        const updatedReminder = { ...storedReminder.data };
        updatedReminder.remindAt = DateTime.fromJSDate(newDate).setZone('Asia/Kolkata', { keepLocalTime: true }).toISO();
        updatedReminder.triggered = false;
        await storedReminder.message.edit(JSON.stringify(updatedReminder));
        scheduleReminder(updatedReminder);
        const snoozeDescription = describeSnoozeDuration(snoozeTimeMs);
        const snoozedUntilUnix = Math.floor(newDate.getTime() / 1000);
        await interaction.update({ content: `<@${interaction.user.id}> Reminder snoozed until <t:${snoozedUntilUnix}:F> (${snoozeDescription}).`, components: [] });
      } catch (err) {
        console.error('Error handling snooze button:', err);
        try {
          await interaction.reply({ content: 'An error occurred while snoozing your reminder. Please try again later.', ephemeral: true });
        } catch (replyErr) {
          console.error('Error sending snooze error reply:', replyErr);
        }
      }
    } else if (customId.startsWith('cancel_')) {
      const reminderId = customId.slice('cancel_'.length);
      try {
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available.', ephemeral: true });
          return;
        }

        const storedReminder = await fetchStoredReminderMessage(storageChannel, reminderId, interaction.user.id);
        if (!storedReminder) {
          await interaction.reply({ content: 'This reminder no longer exists or you are not authorized to cancel it.', ephemeral: true });
          return;
        }

        cancelScheduledJob(reminderId);
        await storedReminder.message.delete();

        await interaction.update({ content: `<@${interaction.user.id}> Reminder cancelled.`, components: [] });
      } catch (err) {
        console.error('Error handling cancel button:', err);
        try {
          await interaction.reply({ content: 'An error occurred while cancelling your reminder. Please try again later.', ephemeral: true });
        } catch (replyErr) {
          console.error('Error sending cancel error reply:', replyErr);
        }
      }
    }
  }
});

// --- Log in to Discord ---
client.login(process.env.DISCORD_TOKEN);
