// A distro picks its compiler's default -march, and helpers run on CPUs
// older than any CI runner (#3038). Other architectures reject these flags.
function linuxBaselineFlags(arch = process.arch) {
  return arch === "x64" ? ["-march=x86-64", "-mtune=generic"] : [];
}

module.exports = { linuxBaselineFlags };
