const test = require("node:test");
const assert = require("node:assert/strict");
const { parse: parseDotenv } = require("dotenv");

const {
  MAX_REASON_LENGTH,
  extractWhisperGpuFailureReason: extractReason,
} = require("../../src/helpers/whisperGpuFailureReason");
const {
  VULKAN_DEVICE_LOST_STDERR,
  CUDA_KERNEL_IMAGE_STDERR,
  CUDA_OUT_OF_MEMORY_STDERR,
} = require("./harness/whisperServerStderr");

const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";

test("#1340: finds the createDevice error that a 200-character slice of stderr cuts off", () => {
  // The warn log kept stderrBuffer.slice(0, 200): all banner, no cause
  assert.equal(VULKAN_DEVICE_LOST_STDERR.slice(0, 200).includes("ErrorDeviceLost"), false);
  assert.equal(extractReason({ stderr: VULKAN_DEVICE_LOST_STDERR, exitCode: 3 }), DEVICE_LOST);
});

test("CUDA: the kernel-image error wins over the abort lines after it", () => {
  assert.equal(
    extractReason({ stderr: CUDA_KERNEL_IMAGE_STDERR, signal: "SIGABRT" }),
    "CUDA error: no kernel image is available for execution on the device"
  );
});

test("CUDA: an out-of-memory load reports the first failed allocation, not the assert", () => {
  assert.equal(
    extractReason({ stderr: CUDA_OUT_OF_MEMORY_STDERR, exitCode: 3 }),
    "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1533.14 MiB on device 0: cudaMalloc failed: out of memory"
  );
});

test("reads an uncaught Vulkan exception from its what() line", () => {
  const stderr = [
    "terminate called after throwing an instance of 'vk::DeviceLostError'",
    "  what():  vk::Queue::submit: ErrorDeviceLost",
  ].join("\n");
  assert.equal(extractReason({ stderr, signal: "SIGABRT" }), "vk::Queue::submit: ErrorDeviceLost");
});

test("an unrecognised error line beats the generic load-failure lines after it", () => {
  const stderr = [
    "ggml_vulkan: Found 1 Vulkan devices:",
    "ggml_vulkan: Error: Vulkan 1.2 required.",
    "whisper_init_with_params_no_state: failed to load model",
    "error: failed to initialize whisper context",
  ].join("\n");
  assert.equal(extractReason({ stderr, exitCode: 3 }), "ggml_vulkan: Error: Vulkan 1.2 required.");
});

test("with only the generic load-failure lines, the first one is kept", () => {
  const stderr = [
    "whisper_model_load: invalid model data (bad magic)",
    "whisper_init_with_params_no_state: failed to load model",
    "error: failed to initialize whisper context",
  ].join("\n");
  assert.equal(
    extractReason({ stderr, exitCode: 3 }),
    "whisper_init_with_params_no_state: failed to load model"
  );
});

test("without an error line, reports how the process ended", () => {
  const banner = "ggml_vulkan: Found 1 Vulkan devices:\n";
  // A driver crash or a missing DLL on Windows prints nothing and exits with an NTSTATUS code
  assert.equal(extractReason({ stderr: banner, exitCode: 3221225477 }), "exit code 3221225477");
  assert.equal(extractReason({ stderr: banner, signal: "SIGSEGV" }), "terminated by SIGSEGV");
  assert.equal(
    extractReason({ stderr: banner, timeoutMs: 120000 }),
    "startup timed out after 120 s"
  );
  assert.equal(extractReason({ stderr: "", exitCode: 3, timeoutMs: 120000 }), "exit code 3");
  assert.equal(extractReason({}), null);
});

test("reads only the last 16 KB, so a long-running server's old lines are ignored", () => {
  const stderr =
    "error: failed to read WAV file 'old.wav'\n" +
    "whisper_print_timings:    total time =    10.00 ms\n".repeat(400);
  assert.ok(stderr.length > 16 * 1024);
  assert.equal(extractReason({ stderr, exitCode: 3221225477 }), "exit code 3221225477");
});

test("returns one line, capped at MAX_REASON_LENGTH", () => {
  const long = extractReason({ stderr: `error: ${"x".repeat(500)}` });
  assert.equal(long.length, MAX_REASON_LENGTH);
  assert.ok(long.endsWith("…"));
  assert.equal(extractReason({ stderr: "error:\tfirst \u0007 second" }), "error: first second");
});

test("replaces the user's home folder with ~ in any letter case or slash style", () => {
  const homeDir = "C:\\Users\\Mika";
  assert.equal(
    extractReason({ stderr: "error: failed to read 'c:\\users\\MIKA\\a.wav'", homeDir }),
    "error: failed to read '~\\a.wav'"
  );
  assert.equal(
    extractReason({ stderr: "error: failed to read 'C:/Users/Mika/a.wav'", homeDir }),
    "error: failed to read '~/a.wav'"
  );
});

test("the reason survives the raw KEY=value line it is saved as in .env", () => {
  // EnvironmentManager writes KEY=value unquoted. dotenv reads "#" as a comment,
  // and a value that starts with a quote runs on to the next line ending in that
  // quote, swallowing the keys between. Each later line ends in a quote to prove it.
  const laterLines = "WHISPER_THREADS=4\nA=1'\nB=2\"\nC=3`\n";
  for (const line of [
    "error: bad #5",
    "'error: single quoted'",
    '"error: C:\\new\\folder',
    "`error` in backticks",
    "error: a=b: c",
    "error: $HOME",
  ]) {
    const reason = extractReason({ stderr: line, homeDir: null });
    const env = parseDotenv(`WHISPER_GPU_FAILED_REASON_VULKAN=${reason}\n${laterLines}`);
    assert.equal(env.WHISPER_GPU_FAILED_REASON_VULKAN, reason, line);
    assert.equal(env.WHISPER_THREADS, "4", `${line} swallowed the next key`);
  }
});
