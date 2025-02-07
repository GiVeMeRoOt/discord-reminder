// index.js
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const schedule = require('node-schedule');
const chrono = require('chrono-node');
require('dotenv').config();

// The ID of the channel where reminder data is stored (set in .env)
const STORAGE_CHANNEL_ID = process.env.REMINDER_STORAGE_CHANNEL_ID;

// Create a new client instance with guild intents
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Slash Command Registration ---
const commands = [
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a reminder (e.g. "/remind at 3pm tomorrow")')
    .addStringOption(option =>
      option.setName('time')
            .setDescription('When to be reminded (e.g. "at 3pm tomorrow")')
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
function scheduleReminder(reminder) {
  try {
    const remindAt = new Date(reminder.remindAt);
    if (remindAt <= new Date()) return;

    schedule.scheduleJob(remindAt, async function () {
      try {
        const channel = await client.channels.fetch(reminder.channelId);
        if (!channel) {
          console.error(`Channel ${reminder.channelId} not found for reminder ${reminder.id}`);
          return;
        }
        // Send the reminder message in the channel, tagging the user.
        await channel.send(`<@${reminder.userId}> Reminder: It's time!`);

        // Delete the corresponding storage message from the storage channel.
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
          if (storageMessage) await storageMessage.delete();
        }
      } catch (err) {
        console.error(`Error sending reminder ${reminder.id}:`, err);
      }
    });
  } catch (err) {
    console.error(`Error scheduling reminder ${reminder.id}:`, err);
  }
}

// --- On Bot Startup: Reschedule Reminders ---
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

// --- Handle /remind Command ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'remind') {
    try {
      const timeInput = interaction.options.getString('time');
      const scheduledDate = chrono.parseDate(timeInput, new Date());
      if (!scheduledDate) {
        await interaction.reply({ content: 'Sorry, I could not understand that time. Please try a different format.', ephemeral: true });
        return;
      }
      if (scheduledDate <= new Date()) {
        await interaction.reply({ content: 'The time specified is in the past. Please enter a future time.', ephemeral: true });
        return;
      }

      const reminderId = Date.now().toString();
      const reminderData = {
        id: reminderId,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        remindAt: scheduledDate.toISOString()
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

      await interaction.reply(`Alright, <@${interaction.user.id}>, I will remind you <t:${Math.floor(scheduledDate / 1000)}:R>.`);
    } catch (err) {
      console.error('Error handling /remind command:', err);
      try {
        await interaction.reply({ content: 'An error occurred while setting your reminder. Please try again later.', ephemeral: true });
      } catch (replyErr) {
        console.error('Error sending error reply:', replyErr);
      }
    }
  }
});

// --- Log in to Discord ---
client.login(process.env.DISCORD_TOKEN);
