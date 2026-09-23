const os = require("os");

// A GPU whisper-server that falls back to CPU used to leave only its backend
// name behind (WHISPER_GPU_FAILED), so neither the settings card nor a bug
// report could say why (#1736). This picks the stderr line that explains it.

// The cause is printed last, just before the process exits. Reading only the
// tail also keeps a long-running server's older output out of the answer.
const STDERR_TAIL_CHARS = 16 * 1024;
const MAX_REASON_LENGTH = 240;

// Where the reason is saved: one .env key per backend beside WHISPER_GPU_FAILED,
// set and cleared with it (ipcHandlers, whisperGpuUpgradeReset) and listed in
// environment.js PERSISTED_KEYS so a .env rewrite keeps it.
const WHISPER_GPU_FAILURE_REASON_KEYS = Object.freeze({
  cuda: "WHISPER_GPU_FAILED_REASON_CUDA",
  vulkan: "WHISPER_GPU_FAILED_REASON_VULKAN",
});

// Most specific first; the capture group is the reason. Formats are from the
// pinned OpenWhispr/whisper.cpp tag.
const CAUSE_PATTERNS = [
  // src/whisper.cpp (whisper_init_with_params_no_state) catches the backend's
  // C++ exception around model load, e.g. ggml-vulkan's createDevice throwing
  // vk::DeviceLostError: "...: exception during model load: <what()>"
  /exception during model load: (.+)/,
  // ggml-vulkan's VK_CHECK and fence wait print this and exit(1), e.g.
  // "ggml_vulkan: error ErrorDeviceLost at .../ggml-vulkan.cpp:2209"
  /(ggml_vulkan: .*\berror Error\w+.*)/,
  // vulkan-hpp's exception text wherever else it surfaces, e.g. the "what():"
  // line of an exception nothing caught. \berror\b cannot see "ErrorDeviceLost".
  /(vk::\S+: Error\w+)/,
  // ggml-cuda.cu ggml_cuda_error: "CUDA error: <cudaGetErrorString>"
  /(CUDA error: .+)/,
];
// Any other error line; the first one is the closest to the cause.
const ERROR_LINE = /\b(?:error|failed|failure|exception|abort(?:ed)?)\b/i;
// ggml_abort and the assert macros print "<source file>:<line>: <message>" and
// abort, e.g. "…/ggml-vulkan.cpp:8412: Requested preallocation size is too large".
// Often no error word, and after an error line it is only the consequence.
const ABORT_LINE = /^(?:WHISPER_ASSERT: )?\S+\.(?:c|cpp|cu|cuh|h):\d+: /;
// What whisper.cpp and whisper-server print after any failed load. They say
// that loading failed, never why, so they are the answer of last resort.
const LOAD_FAILURE_ECHO = /failed to load model|failed to initialize whisper context/;
// Warnings the backends log and then carry on from (a CPU-side buffer instead
// of pinned memory, a copy instead of an imported host pointer, the Vulkan
// loader skipping one of several drivers). They carry error text, so they would
// otherwise outrank the line that killed it. The non-pinned abort is fatal.
const RECOVERED_WARNING =
  /(?<!non-)pinned memory|^WARNING:|\[Loader Message\]|Failed getMemoryHostPointerPropertiesEXT|Failed ggml_vk_create_buffer/;

function findCauseLine(lines) {
  for (const pattern of CAUSE_PATTERNS) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
  }
  return (
    lines.find((line) => ERROR_LINE.test(line) && !LOAD_FAILURE_ECHO.test(line)) ||
    lines.find((line) => ABORT_LINE.test(line)) ||
    lines.find((line) => LOAD_FAILURE_ECHO.test(line)) ||
    null
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One line that is safe to show and to save. EnvironmentManager writes .env
// values raw (KEY=value), and dotenv reads "#" as a comment and a leading
// quote as the start of a quoted value that can run over later keys. A trailing
// quote can close one an earlier line left open (a backtick hotkey).
function sanitizeReason(text, homeDir) {
  let reason = String(text);
  if (homeDir) {
    // People screenshot this into public issues, and a home folder is often
    // named after its owner.
    for (const home of new Set([homeDir, homeDir.replace(/\\/g, "/")])) {
      reason = reason.replace(new RegExp(escapeRegExp(home), "gi"), "~");
    }
  }
  reason = reason
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/#/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, "");
  if (reason.length > MAX_REASON_LENGTH) {
    reason = `${reason.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`;
  }
  return reason || null;
}

/**
 * The key line explaining why a GPU whisper-server failed, or how the process
 * ended when its output names no cause. One line of at most MAX_REASON_LENGTH
 * characters, or null when there is nothing to report.
 */
function extractWhisperGpuFailureReason({
  stderr = "",
  exitCode = null,
  signal = null,
  timeoutMs = null,
  homeDir = os.homedir(),
} = {}) {
  const lines = String(stderr || "")
    .slice(-STDERR_TAIL_CHARS)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !RECOVERED_WARNING.test(line));
  const cause = findCauseLine(lines);
  const reason = cause ? sanitizeReason(cause, homeDir) : null;
  if (reason) return reason;
  // No line names the cause (a driver crash, a missing DLL, a hang): say how it ended
  if (signal) return `terminated by ${signal}`;
  if (exitCode !== null && exitCode !== undefined) return `exit code ${exitCode}`;
  if (timeoutMs) return `startup timed out after ${Math.round(timeoutMs / 1000)} s`;
  return null;
}

module.exports = {
  MAX_REASON_LENGTH,
  WHISPER_GPU_FAILURE_REASON_KEYS,
  extractWhisperGpuFailureReason,
};
