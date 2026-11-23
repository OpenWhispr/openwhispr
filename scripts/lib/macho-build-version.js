// Reads the oldest macOS a Mach-O image was built to run on (the minos of its
// LC_BUILD_VERSION command), the way otool prints it.
const MH_MAGIC_64 = 0xfeedfacf;
const MACH_HEADER_64_SIZE = 32;
const LC_BUILD_VERSION = 0x32;

function readMinimumMacOS(image) {
  if (image.length < MACH_HEADER_64_SIZE || image.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error("not a thin 64-bit Mach-O image");
  }

  const commandCount = image.readUInt32LE(16);
  let offset = MACH_HEADER_64_SIZE;
  for (let index = 0; index < commandCount; index += 1) {
    if (image.readUInt32LE(offset) === LC_BUILD_VERSION) {
      // Encoded as xxxx.yy.zz in nibbles.
      const minos = image.readUInt32LE(offset + 12);
      const version = [minos >>> 16, (minos >>> 8) & 0xff];
      if (minos & 0xff) version.push(minos & 0xff);
      return version.join(".");
    }
    offset += image.readUInt32LE(offset + 4);
  }

  throw new Error("Mach-O image has no LC_BUILD_VERSION command");
}

module.exports = { readMinimumMacOS };
