const { ContainerBuilder, TextDisplayBuilder } = require('discord.js');
const { toHex } = require('./color');

// Generic "duel cancelled" container, used by every duel command
// (declined, timed out, etc.) so the look stays consistent.
function buildCancelledContainer(config, title, reason) {
  return new ContainerBuilder()
    .setAccentColor(toHex(config.colors.danger))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${reason}`));
}

module.exports = { buildCancelledContainer };
