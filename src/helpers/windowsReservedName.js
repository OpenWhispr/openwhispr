// Names Windows keeps for its devices: a file or folder named like one, with or without an
// extension, and with or without spaces before it, can't be created there.
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\..*)?$/i;

module.exports = { WINDOWS_RESERVED_NAME };
