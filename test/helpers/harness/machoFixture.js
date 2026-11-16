// Minimal thin arm64 Mach-O images for exercising
// scripts/lib/macho-build-version.js without real macOS binaries: a header, an
// LC_UUID the reader has to step over, then LC_BUILD_VERSION.
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 0x2;
const LC_UUID = 0x1b;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
const HEADER_SIZE = 32;
const UUID_COMMAND_SIZE = 24;
const BUILD_VERSION_COMMAND_SIZE = 24;

function encodeVersion(version) {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  return (major << 16) | (minor << 8) | patch;
}

function buildMachOImage({ minos = "13.3", sdk = "26.5" } = {}) {
  const commands = minos === null ? 1 : 2;
  const commandsSize = UUID_COMMAND_SIZE + (minos === null ? 0 : BUILD_VERSION_COMMAND_SIZE);
  const image = Buffer.alloc(HEADER_SIZE + commandsSize);

  image.writeUInt32LE(MH_MAGIC_64, 0);
  image.writeUInt32LE(CPU_TYPE_ARM64, 4);
  image.writeUInt32LE(MH_EXECUTE, 12);
  image.writeUInt32LE(commands, 16);
  image.writeUInt32LE(commandsSize, 20);

  image.writeUInt32LE(LC_UUID, HEADER_SIZE);
  image.writeUInt32LE(UUID_COMMAND_SIZE, HEADER_SIZE + 4);

  if (minos !== null) {
    const offset = HEADER_SIZE + UUID_COMMAND_SIZE;
    image.writeUInt32LE(LC_BUILD_VERSION, offset);
    image.writeUInt32LE(BUILD_VERSION_COMMAND_SIZE, offset + 4);
    image.writeUInt32LE(PLATFORM_MACOS, offset + 8);
    image.writeUInt32LE(encodeVersion(minos), offset + 12);
    image.writeUInt32LE(encodeVersion(sdk), offset + 16);
  }

  return image;
}

module.exports = { buildMachOImage };
