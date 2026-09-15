const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config.json');

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

const commands = commandFiles.map((file) => require(path.join(commandsPath, file)).data.toJSON());

const rest = new REST().setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash command(s)...`);

    if (config.guildId) {
      // Guild-scoped: updates instantly, ideal while developing.
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
      console.log(`Registered commands for guild ${config.guildId}.`);
    } else {
      // Global: can take up to ~1 hour to propagate.
      await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
      console.log('Registered global commands.');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();
