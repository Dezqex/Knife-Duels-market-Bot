const crypto = require('crypto');
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require('discord.js');
const { isChannelAllowed } = require('../utils/channelAccess');
const { createGame, getGame, deleteGame, isUserBusy } = require('../utils/gameStore');
const { toHex } = require('../utils/color');
const { buildCancelledContainer } = require('../utils/uiComponents');
const { logMatch } = require('../utils/matchLog');
const sleep = require('../utils/sleep');

const PREFIX = 'cf';

// Cryptographically secure coin flip — true = heads, false = tails.
// Using crypto.randomInt instead of Math.random means the outcome can't be
// predicted or influenced by seeding/timing tricks, so both players get a
// genuine 50/50 shot every time.
function flipCoin() {
  return crypto.randomInt(2) === 0;
}

// ---------- UI builders ----------

// Lets the challenger pick heads or tails. Only the challenger can use this
// menu; the opponent is automatically assigned whichever side is left over.
function sideSelectRow(state, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:side:${state.id}`)
      .setPlaceholder('Choose your side')
      .setDisabled(disabled)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Heads')
          .setValue('heads')
          .setDefault(state.challengerSide === 'heads'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Tails')
          .setValue('tails')
          .setDefault(state.challengerSide === 'tails')
      )
  );
}

function lockInRow(gameId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:lock:${gameId}`)
      .setLabel('Lock In')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

function confirmRow(gameId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:confirm:${gameId}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:decline:${gameId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

// Phase 1: Challenger picks heads/tails and locks it in.
function buildSidePickContainer(state, config) {
  const e = config.emojis;

  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.flip} Coinflip Duel\nFirst to **${state.firstTo}** wins.`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${state.challenger.id}> wagers: ${state.challengerBet}\n` +
          `<@${state.opponent.id}> wagers: ${state.opponentBet}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${e.coinHeads}${e.coinTails} <@${state.challenger.id}>, pick your side and press **Lock In**.`
      )
    );

  container.addActionRowComponents(sideSelectRow(state, false));
  container.addActionRowComponents(lockInRow(state.id, false));
  return container;
}

// Phase 2: Side is locked, both players confirm/decline.
function buildConfirmContainer(state, config, statusLine) {
  const e = config.emojis;
  const challengerMark = state.confirmed.has(state.challenger.id) ? e.check : e.pending;
  const opponentMark = state.confirmed.has(state.opponent.id) ? e.check : e.pending;
  const challengerSideLabel = state.challengerSide === 'tails' ? 'Tails' : 'Heads';
  const opponentSideLabel = state.challengerSide === 'tails' ? 'Heads' : 'Tails';

  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.flip} Coinflip Duel\nFirst to **${state.firstTo}** wins.`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${state.challenger.id}> wagers: ${state.challengerBet}\n` +
          `<@${state.opponent.id}> wagers: ${state.opponentBet}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${e.coinHeads}${e.coinTails} <@${state.challenger.id}> picked **${challengerSideLabel}** — ` +
          `<@${state.opponent.id}> gets **${opponentSideLabel}**.`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${challengerMark} <@${state.challenger.id}>\n${opponentMark} <@${state.opponent.id}>`
      )
    );

  if (statusLine) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine));
  }

  // Dropdown is always disabled in Phase 2 — side is already locked.
  container.addActionRowComponents(sideSelectRow(state, true));
  container.addActionRowComponents(confirmRow(state.id, state.finished));
  return container;
}

function buildFlipContainer(state, config, lastResult) {
  const e = config.emojis;
  const headsUser = state.sides.heads;
  const tailsUser = state.sides.tails;

  const lastLine = lastResult
    ? `Landed on **${lastResult.toUpperCase()}**! ${lastResult === 'heads' ? e.coinHeads : e.coinTails}`
    : `${e.flip} Flipping...`;

  return new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${e.flip} Coinflip Duel — First to ${state.firstTo}`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${e.coinHeads} <@${headsUser.id}> (Heads): ${state.score[headsUser.id]}\n` +
          `${e.coinTails} <@${tailsUser.id}> (Tails): ${state.score[tailsUser.id]}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lastLine));
}

function buildResultContainer(state, config, winner, loser, wonBet) {
  const e = config.emojis;
  return new ContainerBuilder()
    .setAccentColor(toHex(config.colors.success))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${e.trophy} <@${winner.id}> wins the coinflip!`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Final score: **${state.score[winner.id]} - ${state.score[loser.id]}**\n` +
          `<@${winner.id}> wins **${wonBet}** from <@${loser.id}>.`
      )
    );
}

// ---------- Command ----------

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Challenge another user to a coinflip duel over virtual items.')
    .addUserOption((opt) =>
      opt.setName('opponent').setDescription('The user you want to challenge').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('first-to')
        .setDescription('Number of wins needed to win the match')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20)
    )
    .addStringOption((opt) =>
      opt.setName('your-bet').setDescription('What you are wagering').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('opponent-bet').setDescription('What you expect your opponent to wager').setRequired(true)
    ),

  async execute(interaction, { config, client }) {
    if (!isChannelAllowed('coinflip', interaction.channelId, config)) {
      await interaction.reply({ content: 'This command cannot be used in this channel.', flags: MessageFlags.Ephemeral });
      return;
    }

    const opponent = interaction.options.getUser('opponent');
    const firstTo = interaction.options.getInteger('first-to');
    const challengerBet = interaction.options.getString('your-bet');
    const opponentBet = interaction.options.getString('opponent-bet');

    if (opponent.id === interaction.user.id) {
      await interaction.reply({ content: 'You cannot challenge yourself.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (opponent.bot) {
      await interaction.reply({ content: 'You cannot challenge a bot.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (isUserBusy(interaction.user.id) || isUserBusy(opponent.id)) {
      await interaction.reply({
        content: 'One of you is already in an ongoing duel. Finish that one first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const maxFirstTo = (config.coinflip && config.coinflip.maxFirstTo) || 20;
    if (firstTo > maxFirstTo) {
      await interaction.reply({ content: `First-to cannot be greater than ${maxFirstTo}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const gameId = interaction.id;
    const state = {
      id: gameId,
      channelId: interaction.channelId,
      challenger: { id: interaction.user.id, username: interaction.user.username },
      opponent: { id: opponent.id, username: opponent.username },
      challengerBet,
      opponentBet,
      firstTo,
      challengerSide: 'heads',
      sideLocked: false,
      confirmed: new Set(),
      finished: false,
    };
    createGame(gameId, state);

    await interaction.reply({
      components: [buildSidePickContainer(state, config)],
      flags: MessageFlags.IsComponentsV2,
    });

    const message = await interaction.fetchReply();
    state.messageId = message.id;

    const confirmTimeoutMs = ((config.coinflip && config.coinflip.confirmationTimeoutSeconds) || 60) * 1000;
    const flipIntervalMs = (config.coinflip && config.coinflip.flipIntervalMs) || 1500;

    const collector = message.createMessageComponentCollector({
      filter: (i) => {
        const parts = i.customId.split(':');
        return parts[0] === PREFIX && parts[2] === gameId;
      },
      time: confirmTimeoutMs,
    });

    collector.on('collect', async (i) => {
      const parts = i.customId.split(':');
      const action = parts[1];

      if (i.user.id !== state.challenger.id && i.user.id !== state.opponent.id) {
        await i.reply({ content: 'You are not part of this duel.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'side') {
        if (i.user.id !== state.challenger.id) {
          await i.reply({ content: 'Only the challenger can choose a side.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (state.sideLocked) {
          await i.reply({ content: 'Your side is already locked in.', flags: MessageFlags.Ephemeral });
          return;
        }

        state.challengerSide = i.values[0] === 'tails' ? 'tails' : 'heads';
        await i.update({
          components: [buildSidePickContainer(state, config)],
        });
        return;
      }

      if (action === 'lock') {
        if (i.user.id !== state.challenger.id) {
          await i.reply({ content: 'Only the challenger can lock in a side.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (state.sideLocked) {
          await i.reply({ content: 'Your side is already locked in.', flags: MessageFlags.Ephemeral });
          return;
        }

        state.sideLocked = true;
        await i.update({
          components: [buildConfirmContainer(state, config, 'Both players must press **Confirm** to start.')],
        });
        return;
      }

      if (action === 'decline') {
        state.finished = true;
        collector.stop('declined');
        await i.update({
          components: [
            buildCancelledContainer(config, `${config.emojis.cross} Coinflip Cancelled`, `<@${i.user.id}> declined the duel.`),
          ],
        });
        deleteGame(gameId);
        return;
      }

      if (action === 'confirm') {
        state.confirmed.add(i.user.id);

        if (state.confirmed.size < 2) {
          await i.update({
            components: [buildConfirmContainer(state, config, 'Both players must press **Confirm** to start.')],
          });
          return;
        }

        state.finished = true;
        collector.stop('started');

        // The challenger picked their side via the dropdown; the opponent
        // automatically gets whichever side is left over.
        state.sides = state.challengerSide === 'tails'
          ? { heads: state.opponent, tails: state.challenger }
          : { heads: state.challenger, tails: state.opponent };
        state.score = { [state.challenger.id]: 0, [state.opponent.id]: 0 };

        await i.update({ components: [buildFlipContainer(state, config, null)] });

        while (
          state.score[state.challenger.id] < state.firstTo &&
          state.score[state.opponent.id] < state.firstTo
        ) {
          await sleep(flipIntervalMs);
          const result = flipCoin() ? 'heads' : 'tails';
          const flipWinner = state.sides[result];
          state.score[flipWinner.id] += 1;

          // Show where the coin landed.
          await message
            .edit({ components: [buildFlipContainer(state, config, result)], flags: MessageFlags.IsComponentsV2 })
            .catch(() => {});

          const matchOver =
            state.score[state.challenger.id] >= state.firstTo ||
            state.score[state.opponent.id] >= state.firstTo;

          // If the match continues, briefly hold on the result, then switch
          // back to the "Flipping..." state before the next round starts.
          if (!matchOver) {
            await sleep(flipIntervalMs);
            await message
              .edit({ components: [buildFlipContainer(state, config, null)], flags: MessageFlags.IsComponentsV2 })
              .catch(() => {});
          }
        }

        const winner = state.score[state.challenger.id] >= state.firstTo ? state.challenger : state.opponent;
        const loser = winner.id === state.challenger.id ? state.opponent : state.challenger;
        const wonBet = loser.id === state.challenger.id ? state.challengerBet : state.opponentBet;

        await sleep(600);
        await message
          .edit({
            components: [buildResultContainer(state, config, winner, loser, wonBet)],
            flags: MessageFlags.IsComponentsV2,
          })
          .catch(() => {});

        await logMatch(client, config, {
          game: 'coinflip',
          title: `Coinflip Duel · First to ${state.firstTo}`,
          winnerId: winner.id,
          loserId: loser.id,
          amount: wonBet,
          detailLine: `Final score: **${state.score[winner.id]} - ${state.score[loser.id]}**`,
          matchUrl: message.url,
        });

        deleteGame(gameId);
      }
    });

    collector.on('end', async (_collected, reason) => {
      const current = getGame(gameId);
      if (current && !current.finished) {
        current.finished = true;
        await message
          .edit({
            components: [
              buildCancelledContainer(config, `${config.emojis.cross} Coinflip Cancelled`, 'Confirmation timed out.'),
            ],
            flags: MessageFlags.IsComponentsV2,
          })
          .catch(() => {});
        deleteGame(gameId);
      }
    });
  },
};
