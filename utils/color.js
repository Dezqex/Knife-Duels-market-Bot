// Converts a "#RRGGBB" string from config.json into a number for setAccentColor().
function toHex(color) {
  return parseInt(String(color).replace('#', ''), 16);
}

module.exports = { toHex };
