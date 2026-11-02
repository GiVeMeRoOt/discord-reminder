const { describeReminderActionFailure } = require('./reminderStorage');

/**
 * Answer a button press whose reminder could not be acted on.
 *
 * Two properties matter here, and both are easy to lose:
 *
 * 1. The reminder text survives. These buttons usually sit on an older
 *    occurrence of a recurring reminder, and the deferred reply for a component
 *    interaction IS that public message, so an `editReply` carrying `content`
 *    would destroy the reminder the user came back to read. Only `components`
 *    is ever sent.
 * 2. Nothing throws. A rejection escaping this function lands in the caller's
 *    catch block, which answers with a generic error, so a failed ephemeral
 *    notice must not be allowed to cascade.
 *
 * @param {import('discord.js').ButtonInteraction} interaction - Already deferred.
 * @param {string} outcome - A non-`found` REMINDER_ACTION_OUTCOME value.
 * @param {string} action - Verb for the attempted action, e.g. 'cancel'.
 * @returns {Promise<void>}
 */
async function replyToUnavailableReminder(interaction, outcome, action) {
  const { content, retireButtons } = describeReminderActionFailure(outcome, action);
  let retired = false;

  if (retireButtons) {
    try {
      await interaction.editReply({ components: [] });
      retired = true;
    } catch (err) {
      // The message may be gone, or the bot may have lost permission to edit
      // it. Either way the notice below still reaches the user.
      console.error('Error retiring stale reminder buttons:', err);
    }
  }

  // Claimed only once the edit actually succeeded, so the user is never told
  // the buttons are gone while they are still looking at them.
  const notice = retired
    ? `${content} This message is from an earlier occurrence, so its buttons are now removed.`
    : content;

  try {
    await interaction.followUp({ content: notice, ephemeral: true });
  } catch (err) {
    console.error('Error sending unavailable-reminder notice:', err);
  }
}

module.exports = { replyToUnavailableReminder };
