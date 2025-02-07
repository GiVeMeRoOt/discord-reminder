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

// The ID of the channel where reminder data is stored (set in .env)
const STORAGE_CHANNEL_ID = process.env.REMINDER_STORAGE_CHANNEL_ID;

// Create a new Discord client instance with guild intents
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Slash Command Registration ---
// /rme command accepts a required "time" option and an optional "title" option.
// /delrme command deletes a reminder by its ID.
const commands = [
  new SlashCommandBuilder()
    .setName('rme')
    .setDescription('Set a reminder (e.g. "/rme at 22:45")')
    .addStringOption(option =>
      option.setName('time')
            .setDescription('When to be reminded (e.g. "at 22:45" or "tomorrow at 3pm")')
            .setRequired(true))
    .addStringOption(option =>
      option.setName('title')
            .setDescription('Optional title for the reminder')
            .setRequired(false)),
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

// --- Helper: Schedule a Reminder ---
// The reminder object includes: id, userId, channelId, remindAt (ISO string), and optional title.
function scheduleReminder(reminder) {
  try {
    const remindAt = new Date(reminder.remindAt);
    if (remindAt <= new Date()) return; // Do not schedule if time has passed

    const job = schedule.scheduleJob(remindAt, async function () {
      try {
        const channel = await client.channels.fetch(reminder.channelId);
        if (!channel) {
          console.error(`Channel ${reminder.channelId} not found for reminder ${reminder.id}`);
          return;
        }
        // Prepare reminder text, including title if provided.
        let reminderText = reminder.title ? `Reminder: **${reminder.title}**` : "Reminder: It's time!";
        
        // Create snooze buttons.
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
              .setStyle(ButtonStyle.Primary)
          );
        
        // Send the reminder message with snooze buttons.
        await channel.send({
          content: `<@${reminder.userId}> ${reminderText}`,
          components: [row]
        });

        // Instead of deleting, update the stored reminder to mark it as triggered.
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
            currentData.triggered = true;
            await storageMessage.edit(JSON.stringify(currentData));
          }
        }
        // Remove job from the map.
        scheduledJobs.delete(reminder.id);
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
        } else {
          // Optionally delete outdated reminders.
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
    // Handle /rme command
    if (interaction.commandName === 'rme') {
      try {
        const timeInput = interaction.options.getString('time');
        const title = interaction.options.getString('title'); // optional title

        // Use a base reference in IST
        const baseDateIST = DateTime.now().setZone('Asia/Kolkata').toJSDate();
        let parsedDate = chrono.parseDate(timeInput, baseDateIST);
        if (!parsedDate) {
          await interaction.reply({ content: 'Sorry, I could not understand that time. Please try a different format.', ephemeral: true });
          return;
        }
        // Rebuild the date in IST explicitly using the parsed time.
        const dtIST = DateTime.fromObject({
          year: baseDateIST.getFullYear(),
          month: baseDateIST.getMonth() + 1,
          day: baseDateIST.getDate(),
          hour: parsedDate.getHours(),
          minute: parsedDate.getMinutes(),
          second: parsedDate.getSeconds()
        }, { zone: 'Asia/Kolkata' });
        parsedDate = dtIST.toJSDate();
          
        if (parsedDate <= new Date()) {
          await interaction.reply({ content: 'The time specified is in the past. Please enter a future time.', ephemeral: true });
          return;
        }
        
        // Generate a unique reminder ID.
        const reminderId = Date.now().toString();
        const reminderData = {
          id: reminderId,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          remindAt: parsedDate.toISOString(),
          title: title || null
        };

        // Save the reminder in the storage channel as a JSON string.
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available. Cannot set reminder.', ephemeral: true });
          return;
        }
        await storageChannel.send(JSON.stringify(reminderData));

        // Schedule the reminder.
        scheduleReminder(reminderData);

        await interaction.reply(`Alright, <@${interaction.user.id}>, I will remind you <t:${Math.floor(parsedDate.getTime()/1000)}:R>. (Reminder ID: \`${reminderId}\`)`);
      } catch (err) {
        console.error('Error handling /rme command:', err);
        try {
          await interaction.reply({ content: 'An error occurred while setting your reminder. Please try again later.', ephemeral: true });
        } catch (replyErr) {
          console.error('Error sending error reply:', replyErr);
        }
      }
    } else if (interaction.commandName === 'delrme') {
      // Handle /delrme command
      try {
        const reminderId = interaction.options.getString('id').trim();
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available. Cannot delete reminder.', ephemeral: true });
          return;
        }
        const messages = await storageChannel.messages.fetch({ limit: 100 });
        const storageMessage = messages.find(m => {
          try {
            const data = JSON.parse(m.content);
            return data.id === reminderId && data.userId === interaction.user.id;
          } catch (e) {
            return false;
          }
        });
        if (!storageMessage) {
          await interaction.reply({ content: `No reminder found with ID \`${reminderId}\` for you.`, ephemeral: true });
          return;
        }
        if (scheduledJobs.has(reminderId)) {
          scheduledJobs.get(reminderId).cancel();
          scheduledJobs.delete(reminderId);
        }
        await storageMessage.delete();
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
    // Handle button interactions for snoozing
    const customId = interaction.customId;
    if (customId.startsWith('snooze_')) {
      const parts = customId.split('_'); // e.g. ["snooze", "30", "1234567890"]
      let snoozeTimeMs = 0;
      if (parts[1].endsWith('s')) {
        // If ends with 's', treat as seconds.
        snoozeTimeMs = parseInt(parts[1].slice(0, -1), 10) * 1000;
      } else {
        // Otherwise, treat as minutes.
        snoozeTimeMs = parseInt(parts[1], 10) * 60000;
      }
      const reminderId = parts.slice(2).join('_');
      try {
        const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        if (!storageChannel || !storageChannel.isTextBased()) {
          await interaction.reply({ content: 'Storage channel not available.', ephemeral: true });
          return;
        }
        const messages = await storageChannel.messages.fetch({ limit: 100 });
        const storageMessage = messages.find(m => {
          try {
            const data = JSON.parse(m.content);
            return data.id === reminderId && data.userId === interaction.user.id;
          } catch (e) {
            return false;
          }
        });
        if (!storageMessage) {
          await interaction.reply({ content: 'This reminder no longer exists or you are not authorized to snooze it.', ephemeral: true });
          return;
        }
        // Schedule a new reminder for the snooze duration.
        const newDate = new Date(Date.now() + snoozeTimeMs);
        const updatedReminder = JSON.parse(storageMessage.content);
        updatedReminder.remindAt = newDate.toISOString();
        
        // Update the storage message with the new time.
        await storageMessage.edit(JSON.stringify(updatedReminder));
        // Reschedule the reminder.
        scheduleReminder(updatedReminder);
        
        await interaction.update({ content: `<@${interaction.user.id}> Reminder snoozed for ${snoozeTimeMs/60000} minutes.`, components: [] });
      } catch (err) {
        console.error('Error handling snooze button:', err);
        try {
          await interaction.reply({ content: 'An error occurred while snoozing your reminder. Please try again later.', ephemeral: true });
        } catch (replyErr) {
          console.error('Error sending snooze error reply:', replyErr);
        }
      }
    }
  }
});

// --- Log in to Discord ---
client.login(process.env.DISCORD_TOKEN);
