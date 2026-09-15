// Decides whether a given command may be used in a given channel, based on
// the "channelAccess" section of config.json.
//
// Modes:
//  - "all"       -> command can be used anywhere (default if not configured)
//  - "whitelist" -> command can only be used in the listed channel IDs
//  - "blacklist" -> command can be used everywhere EXCEPT the listed channel IDs
function isChannelAllowed(commandName, channelId, config) {
  const access = config.channelAccess && config.channelAccess[commandName];

  if (!access || !access.mode || access.mode === 'all') {
    return true;
  }

  const channels = Array.isArray(access.channels) ? access.channels : [];

  if (access.mode === 'whitelist') {
    return channels.includes(channelId);
  }

  if (access.mode === 'blacklist') {
    return !channels.includes(channelId);
  }

  // Unknown mode -> fail open so a typo in config doesn't lock everyone out silently.
  return true;
}

module.exports = { isChannelAllowed };
