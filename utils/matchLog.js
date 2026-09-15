const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');
const { toHex } = require('./color');

// Posts a compact result card for a finished match into the configured log
// channel, so everyone can scroll back and see recent matches at a glance.
//
// Never throws: a missing/misconfigured log channel, missing permissions, or
// a fetch failure should never break the actual game that just finished, so
// every failure path is swallowed (and logged to the console for debugging).
//
// `entry` shape:
//   game        - 'coinflip' | 'mines'
//   title       - short heading, e.g. "Coinflip Duel"
//   winnerId    - user id of the winner
//   loserId     - user id of the loser
//   amount      - the wager that changed hands
//   detailLine  - optional extra line (final score, board size, ...)
//   matchUrl    - jump link to the match message itself
async function logMatch(client, config, entry) {
  const logging = config.logging || {};
  if (!logging.enabled || !logging.channelId) return;

  try {
    const channel = await client.channels.fetch(logging.channelId);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[matchLog] Configured logging.channelId (${logging.channelId}) is not a usable text channel.`);
      return;
    }

    const e = config.emojis;
    const gameEmojis = { coinflip: e.flip, mines: e.mine, rps: e.rpsLog };
    const gameEmoji = gameEmojis[entry.game] || e.trophy;
    const nowTs = Math.floor(Date.now() / 1000);

    const lines = [
      `${e.trophy} <@${entry.winnerId}> won **${entry.amount}** from <@${entry.loserId}>`,
    ];
    if (entry.detailLine) lines.push(entry.detailLine);
    lines.push(`<t:${nowTs}:R> · [Jump to match](${entry.matchUrl})`);

    const container = new ContainerBuilder()
      .setAccentColor(toHex(config.colors.success))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${gameEmoji} ${entry.title}`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      // The winner/loser mentions above are only there so their names render
      // as clickable user links — we don't want either of them to actually
      // get pinged every time a match is logged, so all mention parsing is
      // switched off here.
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('[matchLog] Failed to post match log:', err);
  }
}

module.exports = { logMatch };