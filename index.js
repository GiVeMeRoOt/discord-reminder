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
const { DateTime } = require('luxon');
const { normalizeLookupPageLimit } = require('./lookupPagination');
const { parseReminderDateTime } = require('./timeParsing');
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

        const reminderButtons = [
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
            .setStyle(ButtonStyle.Primary)
        ];

        if (reminder?.recurrence?.type) {
          // Only show the cancel control for recurring reminders so one-off
          // reminders keep their simple "snooze or let it dismiss" experience.
          reminderButtons.push(
            new ButtonBuilder()
              .setCustomId(`cancel_${reminder.id}`)
              .setLabel('Cancel reminder')
              .setStyle(ButtonStyle.Danger)
          );
        }

        const row = new ActionRowBuilder().addComponents(...reminderButtons);

        await channel.send({
          content: `<@${reminder.userId}> ${reminderText}`,
          components: [row]
        });

        // Update storage message to mark as triggered.
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (storageChannel && storageChannel.isTextBased()) {
          const storedReminder = await fetchStoredReminderMessage(storageChannel, reminder.id, undefined, { storageMessageId: reminder.storageMessageId });
          if (storedReminder) {
            const currentData = storedReminder.data;

            // Persist storage message id when absent so future lookups are O(1).
            if (!currentData.storageMessageId) {
              currentData.storageMessageId = storedReminder.message.id;
              await storedReminder.message.edit(JSON.stringify(currentData));
            }

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
                await storedReminder.message.edit(JSON.stringify(currentData));
                scheduleReminder(currentData);
              } else {
                currentData.triggered = true;
                await storedReminder.message.edit(JSON.stringify(currentData));
              }
            } else {
              currentData.triggered = true;
              await storedReminder.message.edit(JSON.stringify(currentData));
            }
          } else {
            // If the backing record was deleted, do not reschedule the reminder.
            console.warn(`Storage record not found for reminder ${reminder.id}; skipping recurrence update.`);
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
    await forEachStoredReminder(storageChannel, async (message, data) => {
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
        const dt = parseReminderDateTime(timeInputRaw, baseIST);
        if (!dt) {
          await interaction.reply({ content: 'Sorry, I could not understand that time. Please try a different format.', ephemeral: true });
          return;
        }
        // parseReminderDateTime already guarantees a future time (advancing to
        // the next matching occurrence when needed), so no extra bump is applied
        // here. The check below remains as a final safety net.

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
        const storageMessage = await storageChannel.send(JSON.stringify(reminderData));
        reminderData.storageMessageId = storageMessage.id;
        await storageMessage.edit(JSON.stringify(reminderData));

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
        await interaction.deferReply({ ephemeral: true });
        const reminderId = interaction.options.getString('id').trim();
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.editReply({ content: 'Storage channel not available. Cannot delete reminder.' });
          return;
        }
        const storedReminder = await fetchStoredReminderMessage(storageChannel, reminderId, interaction.user.id, { maxPages: Infinity });
        if (!storedReminder) {
          await interaction.editReply({ content: `No reminder found with ID \`${reminderId}\` for you.` });
          return;
        }
        cancelScheduledJob(reminderId);
        await storedReminder.message.delete();
        await interaction.editReply({ content: `Your reminder with ID \`${reminderId}\` has been deleted.` });
      } catch (err) {
        console.error('Error handling /delrme command:', err);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'An error occurred while deleting your reminder. Please try again later.' });
          } else {
            await interaction.reply({ content: 'An error occurred while deleting your reminder. Please try again later.', ephemeral: true });
          }
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
        await interaction.deferUpdate();
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.editReply({ content: 'Storage channel not available.', components: [] });
          return;
        }
        const storedReminder = await fetchStoredReminderMessage(storageChannel, reminderId, interaction.user.id, { maxPages: Infinity });
        if (!storedReminder) {
          await interaction.editReply({ content: 'This reminder no longer exists or you are not authorized to snooze it.', components: [] });
          return;
        }
        const newDate = new Date(Date.now() + snoozeTimeMs);
        const updatedReminder = { ...storedReminder.data };
        // Preserve the exact snooze instant while serialising with IST offset.
        // keepLocalTime=false (default) avoids shifting the reminder backward.
        updatedReminder.remindAt = DateTime.fromJSDate(newDate).setZone('Asia/Kolkata').toISO();
        updatedReminder.triggered = false;
        await storedReminder.message.edit(JSON.stringify(updatedReminder));
        scheduleReminder(updatedReminder);
        const snoozeDescription = describeSnoozeDuration(snoozeTimeMs);
        const snoozedUntilUnix = Math.floor(newDate.getTime() / 1000);
        await interaction.editReply({ content: `<@${interaction.user.id}> Reminder snoozed until <t:${snoozedUntilUnix}:F> (${snoozeDescription}).`, components: [] });
      } catch (err) {
        console.error('Error handling snooze button:', err);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'An error occurred while snoozing your reminder. Please try again later.', components: [] });
          } else {
            await interaction.reply({ content: 'An error occurred while snoozing your reminder. Please try again later.', ephemeral: true });
          }
        } catch (replyErr) {
          console.error('Error sending snooze error reply:', replyErr);
        }
      }
    } else if (customId.startsWith('cancel_')) {
      const reminderId = customId.slice('cancel_'.length);
      try {
        await interaction.deferUpdate();
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.editReply({ content: 'Storage channel not available.', components: [] });
          return;
        }

        const storedReminder = await fetchStoredReminderMessage(storageChannel, reminderId, interaction.user.id, { maxPages: Infinity });
        if (!storedReminder) {
          await interaction.editReply({ content: 'This reminder no longer exists or you are not authorized to cancel it.', components: [] });
          return;
        }

        cancelScheduledJob(reminderId);
        await storedReminder.message.delete();

        await interaction.editReply({ content: `<@${interaction.user.id}> Reminder cancelled.`, components: [] });
      } catch (err) {
        console.error('Error handling cancel button:', err);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'An error occurred while cancelling your reminder. Please try again later.', components: [] });
          } else {
            await interaction.reply({ content: 'An error occurred while cancelling your reminder. Please try again later.', ephemeral: true });
          }
        } catch (replyErr) {
          console.error('Error sending cancel error reply:', replyErr);
        }
      }
    }
  }
});

// --- Log in to Discord ---
client.login(process.env.DISCORD_TOKEN);
