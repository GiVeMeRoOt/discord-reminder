const test = require('node:test');
const assert = require('node:assert');
const { replyToUnavailableReminder } = require('./interactionReplies');
const { REMINDER_ACTION_OUTCOME } = require('./reminderStorage');

/**
 * Minimal stand-in for a deferred discord.js ButtonInteraction. Records every
 * call so tests can assert on the exact payloads, not just on side effects.
 */
function fakeInteraction({ failEdit = false, failFollowUp = false } = {}) {
  return {
    editCalls: [],
    followUps: [],
    async editReply(payload) {
      this.editCalls.push(payload);
      if (failEdit) {
        const err = new Error('Unknown Message');
        err.code = 10008;
        throw err;
      }
    },
    async followUp(payload) {
      this.followUps.push(payload);
      if (failFollowUp) {
        throw new Error('rate limited');
      }
    }
  };
}

test('a missing reminder keeps its text and loses only its buttons', async () => {
  const interaction = fakeInteraction();

  await replyToUnavailableReminder(interaction, REMINDER_ACTION_OUTCOME.MISSING, 'cancel');

  assert.strictEqual(interaction.editCalls.length, 1);
  assert.deepStrictEqual(
    interaction.editCalls[0],
    { components: [] },
    'only components may be sent'
  );
  assert.ok(
    !('content' in interaction.editCalls[0]),
    'sending content would overwrite the public reminder the user came back to read'
  );
  assert.strictEqual(interaction.followUps.length, 1);
  assert.strictEqual(interaction.followUps[0].ephemeral, true);
  assert.match(interaction.followUps[0].content, /no longer active/);
  assert.match(interaction.followUps[0].content, /buttons are now removed/);
});

test('a stranger press leaves the public message completely alone', async () => {
  const interaction = fakeInteraction();

  await replyToUnavailableReminder(interaction, REMINDER_ACTION_OUTCOME.FORBIDDEN, 'snooze');

  assert.deepStrictEqual(interaction.editCalls, [], 'the owner keeps their buttons');
  assert.strictEqual(interaction.followUps.length, 1);
  assert.strictEqual(interaction.followUps[0].ephemeral, true);
  assert.match(interaction.followUps[0].content, /Only the person who created this reminder/);
});

test('a failed button retirement still reaches the user, and does not claim success', async () => {
  const interaction = fakeInteraction({ failEdit: true });

  await replyToUnavailableReminder(interaction, REMINDER_ACTION_OUTCOME.MISSING, 'cancel');

  assert.strictEqual(interaction.followUps.length, 1, 'the notice must survive a failed edit');
  assert.ok(
    !/buttons are now removed/.test(interaction.followUps[0].content),
    'must not tell the user the buttons are gone while they are still visible'
  );
});

test('a failed notice never escapes into the caller error path', async () => {
  // A rejection here would land in the handler catch block, which answers with a
  // generic error and would undo the whole point of this helper.
  const interaction = fakeInteraction({ failFollowUp: true });

  await assert.doesNotReject(
    () => replyToUnavailableReminder(interaction, REMINDER_ACTION_OUTCOME.MISSING, 'cancel')
  );
});

test('an unrecognised outcome neither strips buttons nor blames the user', async () => {
  const interaction = fakeInteraction();

  await replyToUnavailableReminder(interaction, 'storage_unavailable', 'cancel');

  assert.deepStrictEqual(interaction.editCalls, [], 'a live reminder must keep its buttons');
  assert.strictEqual(interaction.followUps.length, 1);
  assert.ok(!/Only the person/.test(interaction.followUps[0].content));
  assert.ok(!/no longer active/.test(interaction.followUps[0].content));
});
