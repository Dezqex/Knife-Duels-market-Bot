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
  MessageFlags,
} = require('discord.js');
const { isChannelAllowed } = require('../utils/channelAccess');
const { createGame, getGame, deleteGame, isUserBusy } = require('../utils/gameStore');
const { toHex } = require('../utils/color');
const { buildCancelledContainer } = require('../utils/uiComponents');
const { logMatch } = require('../utils/matchLog');
const sleep = require('../utils/sleep');

const PREFIX = 'mn';

// ---------- Helpers ----------

// Cryptographically secure coin flip — used for turn order so it can't be
// predicted or influenced.
function coinFlip() {
  return crypto.randomInt(2) === 0;
}

// Picks `count` unique random indices out of [0, total) using a
// cryptographically secure shuffle (Fisher-Yates with crypto.randomInt),
// so the mine layout can't be predicted, seeded, or otherwise rigged.
function pickMineIndices(total, count) {
  const indices = Array.from({ length: total }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return new Set(indices.slice(0, count));
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
        `## ${e.mine} Mines Duel\n${state.cols}x${state.rows} board · **${state.mineCount}** mine(s).\n` +
          `Whoever hits a mine first loses.`
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

// Builds the button grid. `revealAll` shows every tile's true contents
// (mines and gems) — used once the game is over so both players can see
// the whole board, not just the mines.
function buildBoardRows(state, config, revealAll) {
  const e = config.emojis;
  const rows = [];

  for (let r = 0; r < state.rows; r += 1) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < state.cols; c += 1) {
      const idx = r * state.cols + c;
      const isMine = state.mines.has(idx);
      const isRevealed = state.revealed.has(idx);
      const isHitMine = state.hitIndex === idx;

      let style = ButtonStyle.Secondary;
      let label = e.hiddenTile;
      let disabled = state.finished;

      if (isHitMine) {
        style = ButtonStyle.Danger;
        label = e.mine;
        disabled = true;
      } else if (isRevealed) {
        style = ButtonStyle.Success;
        label = e.gem;
        disabled = true;
      } else if (revealAll && isMine) {
        style = ButtonStyle.Secondary;
        label = e.mine;
        disabled = true;
      } else if (revealAll) {
        // Safe tile nobody clicked — show it as a gem too so the whole
        // board is visible at the end of the game.
        style = ButtonStyle.Secondary;
        label = e.gem;
        disabled = true;
      }

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}:pick:${state.id}:${idx}`)
          .setLabel(label)
          .setStyle(style)
          .setDisabled(disabled)
      );
    }
    rows.push(row);
  }

  return rows;
}

// Shown while randomly deciding who moves first. `highlightId` is the
// player currently being "landed on" as the animation cycles between the
// two players; `finalText`, when set, replaces the cycling line with the
// settled result.
function buildRollingContainer(state, config, highlightId, finalText) {
  const e = config.emojis;
  const dice = e.dice || '🎲';

  const line = (userId) =>
    userId === highlightId ? `**▶ <@${userId}> ◀**` : `<@${userId}>`;

  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.mine} Mines Duel\n<@${state.challenger.id}> vs <@${state.opponent.id}> · **${state.mineCount}** mine(s)`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        finalText ||
          `${dice} Rolling to see who goes first...\n\n${line(state.challenger.id)}\n${line(state.opponent.id)}`
      )
    );

  return container;
}

// Animates a few random-looking cycles between the two players, then
// settles on a cryptographically secure pick of who moves first. Returns
// true if the challenger goes first, false if the opponent does.
async function rollForFirst(message, state, config, minesConfig) {
  const challengerFirst = coinFlip();
  const firstPlayer = challengerFirst ? state.challenger : state.opponent;
  const order = [state.challenger.id, state.opponent.id];

  const rollIntervalMs = minesConfig.rollIntervalMs || 350;
  // Random roll-step count so the animation length is unpredictable.
  const minRollSteps = minesConfig.minRollSteps || 6;
  const maxRollSteps = minesConfig.maxRollSteps || minesConfig.rollSteps || 12;
  const rollSteps = crypto.randomInt(minRollSteps, maxRollSteps + 1);

  for (let s = 0; s < rollSteps; s += 1) {
    await message
      .edit({
        components: [buildRollingContainer(state, config, order[s % 2])],
        flags: MessageFlags.IsComponentsV2,
      })
      .catch(() => {});
    await sleep(rollIntervalMs);
  }

  await message
    .edit({
      components: [
        buildRollingContainer(
          state,
          config,
          firstPlayer.id,
          `${config.emojis.dice || '🎲'} <@${firstPlayer.id}> won the roll and goes first!`
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    })
    .catch(() => {});
  await sleep(900);

  return challengerFirst;
}

function buildGameContainer(state, config, statusLine) {
  const e = config.emojis;
  const current = state.turnOrder[state.turnIndex];

  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.primary))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.mine} Mines Duel\n<@${state.challenger.id}> vs <@${state.opponent.id}> · **${state.mineCount}** mine(s)`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine || `It's <@${current.id}>'s turn.`));

  const rows = buildBoardRows(state, config, false);
  for (const row of rows) container.addActionRowComponents(row);

  return container;
}

function buildResultContainer(state, config, winner, loser, wonBet) {
  const e = config.emojis;
  const container = new ContainerBuilder()
    .setAccentColor(toHex(config.colors.success))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${e.trophy} <@${winner.id}> wins the Mines duel!`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${loser.id}> hit a mine.\n<@${winner.id}> wins **${wonBet}** from <@${loser.id}>.`
      )
    );

  const rows = buildBoardRows(state, config, true);
  for (const row of rows) container.addActionRowComponents(row);

  return container;
}

// ---------- Command ----------

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mines')
    .setDescription('Challenge another user to a mines duel over virtual items.')
    .addUserOption((opt) =>
      opt.setName('opponent').setDescription('The user you want to challenge').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('your-bet').setDescription('What you are wagering').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('opponent-bet').setDescription('What you expect your opponent to wager').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('mines')
        .setDescription('Number of mines on the board (default from config)')
        .setMinValue(1)
        .setMaxValue(11)
    ),

  async execute(interaction, { config, client }) {
    if (!isChannelAllowed('mines', interaction.channelId, config)) {
      await interaction.reply({ content: 'This command cannot be used in this channel.', flags: MessageFlags.Ephemeral });
      return;
    }

    const opponent = interaction.options.getUser('opponent');
    const challengerBet = interaction.options.getString('your-bet');
    const opponentBet = interaction.options.getString('opponent-bet');

    const minesConfig = config.mines || {};
    const rows = minesConfig.rows || 3;
    const cols = minesConfig.cols || 4;
    const totalCells = rows * cols;

    const requestedMines = interaction.options.getInteger('mines');
    const defaultMineCount = minesConfig.defaultMineCount || 1;
    const mineCount = Math.min(
      Math.max(requestedMines ?? defaultMineCount, 1),
      totalCells - 1
    );

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

    const gameId = interaction.id;
    const state = {
      id: gameId,
      channelId: interaction.channelId,
      challenger: { id: interaction.user.id, username: interaction.user.username },
      opponent: { id: opponent.id, username: opponent.username },
      challengerBet,
      opponentBet,
      rows,
      cols,
      mineCount,
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

    const confirmTimeoutMs = (minesConfig.confirmationTimeoutSeconds || 60) * 1000;
    const moveTimeoutMs = (minesConfig.moveTimeoutSeconds || 60) * 1000;

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
            buildCancelledContainer(config, `${config.emojis.cross} Mines Cancelled`, `<@${i.user.id}> declined the duel.`),
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

        // Both confirmed -> set up the board and switch the collector to the (longer) move timeout.
        state.mines = pickMineIndices(totalCells, mineCount);
        state.revealed = new Set();
        state.hitIndex = null;

        collector.resetTimer({ idle: moveTimeoutMs });

        // Acknowledge the confirm press, then run a short "rolling" animation
        // so both players can see it's being randomly decided who goes first.
        await i.update({ components: [buildRollingContainer(state, config, null)] });

        // Cryptographically secure coin flip decides who moves first — fair
        // and impossible to predict or influence. The animation itself is
        // just for show; the outcome is picked securely up front.
        const challengerFirst = await rollForFirst(message, state, config, minesConfig);
        state.turnOrder = challengerFirst
          ? [state.challenger, state.opponent]
          : [state.opponent, state.challenger];
        state.turnIndex = 0;

        await message
          .edit({ components: [buildGameContainer(state, config)], flags: MessageFlags.IsComponentsV2 })
          .catch(() => {});
        return;
      }

      // ----- Pick a tile -----
      if (action === 'pick') {
        const idx = Number(parts[3]);
        const current = state.turnOrder[state.turnIndex];

        if (i.user.id !== current.id) {
          await i.reply({ content: "It's not your turn.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (state.revealed.has(idx) || state.hitIndex !== null) {
          await i.reply({ content: 'That tile is already revealed.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (state.mines.has(idx)) {
          // Current player hit a mine and loses.
          state.hitIndex = idx;
          state.finished = true;
          collector.stop('finished');

          const loser = current;
          const winner = loser.id === state.challenger.id ? state.opponent : state.challenger;
          const wonBet = loser.id === state.challenger.id ? state.challengerBet : state.opponentBet;

          await i.update({ components: [buildResultContainer(state, config, winner, loser, wonBet)] });

          await logMatch(client, config, {
            game: 'mines',
            title: 'Mines Duel',
            winnerId: winner.id,
            loserId: loser.id,
            amount: wonBet,
            detailLine: `${state.cols}x${state.rows} board · ${state.mineCount} mine(s)`,
            matchUrl: message.url,
          });

          deleteGame(gameId);
          return;
        }

        // Safe tile: reveal it and pass the turn.
        state.revealed.add(idx);
        state.turnIndex = 1 - state.turnIndex;
        collector.resetTimer({ idle: moveTimeoutMs });

        await i.update({ components: [buildGameContainer(state, config)] });
      }
    });

    collector.on('end', async (_collected, reason) => {
      const current = getGame(gameId);
      if (current && !current.finished) {
        current.finished = true;
        const reasonText = current.turnOrder ? 'A player took too long to move.' : 'Confirmation timed out.';
        await message
          .edit({
            components: [buildCancelledContainer(config, `${config.emojis.cross} Mines Cancelled`, reasonText)],
            flags: MessageFlags.IsComponentsV2,
          })
          .catch(() => {});
        deleteGame(gameId);
      }
    });
  },
};
