const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { isChannelAllowed } = require('../utils/channelAccess');
const { createGame, getGame, deleteGame, isUserBusy } = require('../utils/gameStore');
const { toHex } = require('../utils/color');
const { buildCancelledContainer } = require('../utils/uiComponents');
const { logMatch } = require('../utils/matchLog');

const PREFIX = 'rps';
const MOVES = ['rock', 'paper', 'scissors'];
// What each move beats.
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

// ---------- Helpers ----------

// Returns 'challenger', 'opponent', or 'tie'.
function resolveRound(challengerMove, opponentMove) {
  if (challengerMove === opponentMove) return 'tie';
  return BEATS[challengerMove] === opponentMove ? 'challenger' : 'opponent';
}

// ---------- UI builders ----------

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

function buildConfirmContainer(state, config, statusLine) {
  const e = config.emojis;
  const challengerMark = state.confirmed.has(state.challenger.id) ? e.check : e.pending;
  const opponentMark = state.confirmed.has(state.opponent.id) ? e.check : e.pending;

  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.rock}${e.paper}${e.scissors} Rock Paper Scissors Duel\nFirst to **${state.firstTo}** wins.`
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
        `${challengerMark} <@${state.challenger.id}>\n${opponentMark} <@${state.opponent.id}>`
      )
    );

  if (statusLine) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine));
  }

  container.addActionRowComponents(confirmRow(state.id, state.finished));
  return container;
}

function moveRow(gameId, config, disabled = false) {
  const e = config.emojis;
  return new ActionRowBuilder().addComponents(
    ...MOVES.map((move) =>
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:choose:${gameId}:${move}`)
        .setLabel(move[0].toUpperCase() + move.slice(1))
        .setEmoji(e[move])
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    )
  );
}

// Shows the current score, a compact history of past rounds, and who has
// already locked in a move for this round (without revealing what it is).
function buildRoundContainer(state, config) {
  const e = config.emojis;
  const challengerReady = state.roundChoices.has(state.challenger.id) ? e.check : e.pending;
  const opponentReady = state.roundChoices.has(state.opponent.id) ? e.check : e.pending;

  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.rock}${e.paper}${e.scissors} RPS Duel — First to ${state.firstTo}\n` +
        `<@${state.challenger.id}>: ${state.score[state.challenger.id]}  ·  <@${state.opponent.id}>: ${state.score[state.opponent.id]}`
      )
    );

  addHistorySection(container, state, config);

  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Round ${state.round} — pick your move.\n` +
        `${challengerReady} <@${state.challenger.id}>\n${opponentReady} <@${state.opponent.id}>`
      )
    );

  container.addActionRowComponents(moveRow(state.id, config, state.finished));
  return container;
}

const HISTORY_LIMIT = 6;

// Appends a compact "past rounds" block to a container, capped to the most
// recent HISTORY_LIMIT entries so the message can't grow unbounded over a
// long match. Shared by the in-progress and final containers so the full
// pick history stays visible in one place instead of flooding the channel
// with a separate message per round.
function addHistorySection(container, state, config) {
  if (!state.history || state.history.length === 0) return;

  const shown = state.history.slice(-HISTORY_LIMIT);
  const omitted = state.history.length - shown.length;
  const lines = [];
  if (omitted > 0) lines.push(`_+${omitted} earlier round(s) not shown_`);
  lines.push(...shown);

  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

function buildResultContainer(state, config, winner, loser, wonBet) {
  const e = config.emojis;
  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.success))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${e.trophy} <@${winner.id}> wins the RPS duel!`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Final score: **${state.score[winner.id]} - ${state.score[loser.id]}**\n` +
        `<@${winner.id}> wins **${wonBet}** from <@${loser.id}>.`
      )
    );

  addHistorySection(container, state, config);
  return container;
}

// ---------- Command ----------

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Challenge another user to a rock-paper-scissors duel.')
    .addUserOption((opt) =>
      opt.setName('opponent').setDescription('The user you want to challenge').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('first-to')
        .setDescription('Number of round wins needed to win the match')
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
    if (!isChannelAllowed('rps', interaction.channelId, config)) {
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

    const rpsConfig = config.rps || {};
    const maxFirstTo = rpsConfig.maxFirstTo || 20;
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
      confirmed: new Set(),
      finished: false,
    };
    createGame(gameId, state);

    await interaction.reply({
      components: [buildConfirmContainer(state, config, 'Both players must press **Confirm** to start.')],
      flags: MessageFlags.IsComponentsV2,
    });

    const message = await interaction.fetchReply();
    state.messageId = message.id;

    const confirmTimeoutMs = (rpsConfig.confirmationTimeoutSeconds || 60) * 1000;
    const moveTimeoutMs = (rpsConfig.moveTimeoutSeconds || 60) * 1000;

    const collector = message.createMessageComponentCollector({
      filter: (i) => {
        const parts = i.customId.split(':');
        return parts[0] === PREFIX && parts[2] === gameId;
      },
      idle: confirmTimeoutMs,
    });

    collector.on('collect', async (i) => {
      const parts = i.customId.split(':');
      const action = parts[1];

      if (i.user.id !== state.challenger.id && i.user.id !== state.opponent.id) {
        await i.reply({ content: 'You are not part of this duel.', flags: MessageFlags.Ephemeral });
        return;
      }

      // ----- Decline -----
      if (action === 'decline') {
        state.finished = true;
        collector.stop('declined');
        await i.update({
          components: [
            buildCancelledContainer(config, `${config.emojis.cross} RPS Cancelled`, `<@${i.user.id}> declined the duel.`),
          ],
        });
        deleteGame(gameId);
        return;
      }

      // ----- Confirm -----
      if (action === 'confirm') {
        state.confirmed.add(i.user.id);

        if (state.confirmed.size < 2) {
          await i.update({
            components: [buildConfirmContainer(state, config, 'Both players must press **Confirm** to start.')],
          });
          return;
        }

        state.score = { [state.challenger.id]: 0, [state.opponent.id]: 0 };
        state.round = 1;
        state.roundChoices = new Map();
        state.history = [];

        collector.resetTimer({ idle: moveTimeoutMs });
        await i.update({ components: [buildRoundContainer(state, config)] });
        return;
      }

      // ----- Choose a move -----
      if (action === 'choose') {
        const move = parts[3];

        if (state.roundChoices.has(i.user.id)) {
          await i.reply({ content: 'You already locked in a move this round. Waiting on your opponent...', flags: MessageFlags.Ephemeral });
          return;
        }

        state.roundChoices.set(i.user.id, move);
        // Snapshot this synchronously, before any `await` hands control back
        // to the event loop — otherwise two near-simultaneous clicks can both
        // see size >= 2 and both try to resolve the round.
        const bothChosen = state.roundChoices.size >= 2;
        const e = config.emojis;
        await i.reply({
          content: `You picked ${e[move]} **${move[0].toUpperCase()}${move.slice(1)}**. Waiting for your opponent...`,
          flags: MessageFlags.Ephemeral,
        });

        if (!bothChosen) {
          // Only update the public "who's ready" marks — don't reveal the move itself.
          await message.edit({ components: [buildRoundContainer(state, config)] }).catch(() => { });
          return;
        }

        // Both players have chosen — resolve the round.
        const challengerMove = state.roundChoices.get(state.challenger.id);
        const opponentMove = state.roundChoices.get(state.opponent.id);
        const outcome = resolveRound(challengerMove, opponentMove);

        const moveLabel = (m) => `${e[m]} ${m[0].toUpperCase()}${m.slice(1)}`;
        let historyLine = `**R${state.round}:** ${moveLabel(challengerMove)} vs ${moveLabel(opponentMove)} — `;

        if (outcome === 'tie') {
          historyLine += 'Tie, replayed';
        } else {
          const roundWinner = outcome === 'challenger' ? state.challenger : state.opponent;
          state.score[roundWinner.id] += 1;
          historyLine += `<@${roundWinner.id}> wins`;
        }
        state.history.push(historyLine);

        const matchOver =
          state.score[state.challenger.id] >= state.firstTo ||
          state.score[state.opponent.id] >= state.firstTo;

        if (matchOver) {
          state.finished = true;
          collector.stop('finished');

          const winner = state.score[state.challenger.id] >= state.firstTo ? state.challenger : state.opponent;
          const loser = winner.id === state.challenger.id ? state.opponent : state.challenger;
          const wonBet = loser.id === state.challenger.id ? state.challengerBet : state.opponentBet;

          await message
            .edit({
              components: [buildResultContainer(state, config, winner, loser, wonBet)],
              flags: MessageFlags.IsComponentsV2,
            })
            .catch(() => { });

          await logMatch(client, config, {
            game: 'rps',
            title: `Rock Paper Scissors Duel · First to ${state.firstTo}`,
            winnerId: winner.id,
            loserId: loser.id,
            amount: wonBet,
            detailLine: `Final score: **${state.score[winner.id]} - ${state.score[loser.id]}**`,
            matchUrl: message.url,
          });

          deleteGame(gameId);
          return;
        }

        // Next round — the resolved round's outcome stays visible via the
        // history section, right under the score, in this same message.
        if (outcome !== 'tie') state.round += 1;
        state.roundChoices = new Map();
        collector.resetTimer({ idle: moveTimeoutMs });
        await message.edit({ components: [buildRoundContainer(state, config)] }).catch(() => { });
      }
    });

    collector.on('end', async (_collected, reason) => {
      const current = getGame(gameId);
      if (current && !current.finished) {
        current.finished = true;
        const reasonText = current.round ? 'A player took too long to choose a move.' : 'Confirmation timed out.';
        await message
          .edit({
            components: [buildCancelledContainer(config, `${config.emojis.cross} RPS Cancelled`, reasonText)],
            flags: MessageFlags.IsComponentsV2,
          })
          .catch(() => { });
        deleteGame(gameId);
      }
    });
  },
};