const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.10";

const WINDOWS_MSVC_RUNTIME_LIBRARIES = Object.freeze([
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcomp140.dll",
]);

// CPU builds for processors without AVX2, which whisperServer.js falls back to
// in this order when a build dies of an illegal instruction (#2356). The names
// are upstream ggml's CPU levels:
//   ivybridge    SSE4.2 + AVX + F16C: Intel Ivy Bridge, AMD Piledriver, Steamroller, Jaguar
//   sandybridge  SSE4.2 + AVX: Intel Sandy Bridge, AMD Bulldozer
// ivybridge comes first because F16C matters: without it every fp16 weight is
// converted through a lookup table, and transcription runs several times slower.
const CPU_FALLBACK_LEVELS = Object.freeze(["ivybridge", "sandybridge"]);

function cpuFallbackServerBinaryName(platform, arch, level) {
  return `whisper-server-${platform}-${arch}-${level}${platform === "win32" ? ".exe" : ""}`;
}

module.exports = {
  WHISPER_CPP_TAG,
  WINDOWS_MSVC_RUNTIME_LIBRARIES,
  CPU_FALLBACK_LEVELS,
  cpuFallbackServerBinaryName,
};
