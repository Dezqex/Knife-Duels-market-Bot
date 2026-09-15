# Knife Duels Market Bot

Discord bot that lets people wager their knife duel items against each other in quick 1v1 games. Built on Discord's new Components V2 stuff so everything renders as clean cards instead of plain embeds.


## Games

- **`/coinflip`** - challenge someone, you both confirm, one side gets heads and the other gets tails, then it flips until someone hits "first to X" wins. Winner takes the loser's wager.
- **`/mines`** - challenge someone, confirm up, then you take turns clicking tiles on a grid. First person to click a mine loses. Winner takes the wager.
- **`/rps`** - classic rock paper scissors. Both players pick in secret each round (your pick stays hidden until your opponent has also picked), first to "first to X" round wins takes it all.

## Getting it running

1. `npm install`
2. Fill out `config.json`:
   - `token` - your bot's token, from the Developer Portal under Bot -> Reset Token
   - `clientId` - your application's Client ID, under General Information
   - `guildId` - optional, set this to a server ID while you're developing so commands update instantly. Leave it blank for a global deploy (takes up to an hour to propagate)
3. Invite the bot with `applications.commands` and `bot` scopes, give it Send Messages / Use Slash Commands
4. Push the slash commands: `npm run deploy`
5. Start it up: `npm start`

## Match log channel

Want a running feed of finished duels? Turn it on in `config.json`:

```json
"logging": {
  "enabled": true,
  "channelId": "123456789012345678"
}
```

Only actual finished matches get logged (someone won) - declines and timeouts don't show up. Each log entry has the winner, loser, what was wagered, a quick detail line (final score for coinflip/rps, board size for mines), and a link that jumps straight to the match.

The bot needs View Channel + Send Messages in whatever channel you point it at.

## Locking commands to certain channels

Each command gets its own entry under `channelAccess` in the config:

```json
"mines": {
  "mode": "whitelist",
  "channels": ["123456789012345678"]
}
```

- `"all"` - works anywhere (this is the default)
- `"whitelist"` - only works in the channels you list
- `"blacklist"` - works everywhere except the channels you list

## Making it look right

- `colors` - the accent colors on the message cards (primary / success / danger)
- `emojis` - every emoji the bot uses, swap these for your own server's custom emojis if you want (`<:name:id>`)

## Tuning the games

- `coinflip.maxFirstTo` - cap on the "first to X" option
- `coinflip.confirmationTimeoutSeconds` - how long before an unconfirmed duel gets cancelled
- `coinflip.flipIntervalMs` - pause between flips during the animation
- `mines.rows` / `mines.cols` - board size, defaults to 3x4. Keep cols at 5 or under and rows at 5 or under (Discord caps button grids there)
- `mines.defaultMineCount` - mine count when the `mines` option isn't passed in the command
- `mines.confirmationTimeoutSeconds` - same idea as above
- `mines.moveTimeoutSeconds` - how long the player whose turn it is has before the duel cancels
- `rps.maxFirstTo` - cap on "first to X"
- `rps.confirmationTimeoutSeconds` - same as the others
- `rps.moveTimeoutSeconds` - how long players get to lock in a move each round
- `rps.revealDelayMs` - how long a round's result sits on screen before moving on

## Structure

```
config.json            all the settings above live here
index.js               bot entry point, loads commands and routes interactions
deploy-commands.js     registers the slash commands with Discord
commands/
  coinflip.js
  mines.js
  rps.js
utils/
  channelAccess.js     whitelist/blacklist logic per command
  gameStore.js         tracks active games in memory
  matchLog.js          posts the result summary to the log channel
  color.js             turns hex strings into numbers for setAccentColor()
  sleep.js             small delay helper for the coinflip animation
  uiComponents.js       shared "duel cancelled" card
```