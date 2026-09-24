const test = require("node:test");
const assert = require("node:assert/strict");
const { getSystemErrorMap } = require("node:util");
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

test("a warning the backend recovered from never outranks the error that killed it", () => {
  // ggml-vulkan logs the first two and carries on with a CPU-side buffer; the
  // fence wait in ggml_vk_wait_for_fence then prints the fatal line and exits
  const stderr = [
    "ggml_vulkan: Failed to allocate pinned memory (vk::Device::allocateMemory: ErrorOutOfHostMemory)",
    "WARNING: failed to allocate 512.00 MB of pinned memory",
    "whisper_print_timings:    total time =   812.44 ms",
    "ggml_vulkan: error ErrorDeviceLost at D:\\a\\whisper.cpp\\ggml\\src\\ggml-vulkan\\ggml-vulkan.cpp:2209",
  ].join("\r\n");
  assert.equal(
    extractReason({ stderr, exitCode: 1 }),
    "ggml_vulkan: error ErrorDeviceLost at D:\\a\\whisper.cpp\\ggml\\src\\ggml-vulkan\\ggml-vulkan.cpp:2209"
  );
});

test("a VK_CHECK exit names the Vulkan call that failed", () => {
  const stderr =
    "ggml_vulkan: ctx->device->device.waitForFences({ ctx->almost_ready_fence }, true, UINT64_MAX) error ErrorDeviceLost at ggml-vulkan.cpp:2200\n";
  assert.equal(
    extractReason({ stderr, exitCode: 1 }),
    "ggml_vulkan: ctx->device->device.waitForFences({ ctx->almost_ready_fence }, true, UINT64_MAX) error ErrorDeviceLost at ggml-vulkan.cpp:2200"
  );
});

test("recovered warnings alone are not a cause: the exit is reported instead", () => {
  const stderr = [
    "ggml_vulkan: Failed to allocate pinned memory (vk::Device::allocateMemory: ErrorOutOfHostMemory)",
    "ggml_vulkan: Failed getMemoryHostPointerPropertiesEXT (vk::Device::getMemoryHostPointerPropertiesEXT: ErrorInvalidExternalHandle)",
    "ggml_vulkan: Failed ggml_vk_create_buffer (vk::Device::allocateMemory: ErrorOutOfDeviceMemory)",
    "ggml_cuda_host_malloc: failed to allocate 512.00 MiB of pinned memory: out of memory",
  ].join("\n");
  assert.equal(extractReason({ stderr, exitCode: 3221225477 }), "exit code 0xC0000005");
});

test("a ggml abort with no error word in it is reported, not the exit it caused", () => {
  // ggml_abort prints "<file>:<line>: <message>", then a backtrace, then aborts.
  // The paths are the build machine's, so no home folder is redacted from them.
  const preallocation =
    "D:\\a\\whisper.cpp\\whisper.cpp\\ggml\\src\\ggml-vulkan\\ggml-vulkan.cpp:8412: Requested preallocation size is too large";
  assert.equal(
    extractReason({
      stderr: `ggml_vulkan: Found 1 Vulkan devices:\n${preallocation}\n`,
      exitCode: 3,
      homeDir: null,
    }),
    preallocation
  );
  // It mentions pinned memory but, unlike the warnings above, it is fatal
  const nonPinned =
    "/home/runner/work/whisper.cpp/whisper.cpp/ggml/src/ggml-vulkan/ggml-vulkan.cpp:7507: Asynchronous write to non-pinned memory not supported";
  assert.equal(
    extractReason({ stderr: `${nonPinned}\n`, signal: "SIGABRT", homeDir: null }),
    nonPinned
  );
});

test("the Vulkan loader's notes about drivers it skipped are not a cause", () => {
  // Common with several drivers installed; the loader skips that one and carries on
  const stderr = [
    "ERROR: [Loader Message] Code 0 : loader_scanned_icd_add: Could not get 'vkCreateInstance' via 'vk_icdGetInstanceProcAddr' for ICD libGLX_nvidia.so.0",
    "ggml_vulkan: Found 1 Vulkan devices:",
  ].join("\n");
  assert.equal(extractReason({ stderr, signal: "SIGSEGV" }), "terminated by SIGSEGV");
  assert.equal(extractReason({ stderr, timeoutMs: 120000 }), "startup timed out after 120 s");
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
  assert.equal(extractReason({ stderr: banner, exitCode: 3221225477 }), "exit code 0xC0000005");
  assert.equal(extractReason({ stderr: banner, signal: "SIGSEGV" }), "terminated by SIGSEGV");
  assert.equal(
    extractReason({ stderr: banner, timeoutMs: 120000 }),
    "startup timed out after 120 s"
  );
  assert.equal(extractReason({ stderr: "", exitCode: 3, timeoutMs: 120000 }), "exit code 3");
  assert.equal(extractReason({}), null);
});

test("a Windows crash status reads in hex, the form reporters and search engines know", () => {
  // Node reports GetExitCodeProcess's DWORD unsigned, so 0xC0000005 arrives as 3221225477
  assert.equal(extractReason({ exitCode: 0xc0000135 }), "exit code 0xC0000135");
  assert.equal(extractReason({ exitCode: 0xc0000409 }), "exit code 0xC0000409");
  assert.equal(extractReason({ exitCode: 0x80000003 }), "exit code 0x80000003");
  // An ordinary exit status stays a small decimal number
  assert.equal(extractReason({ exitCode: 1 }), "exit code 1");
  assert.equal(extractReason({ exitCode: 255 }), "exit code 255");
});

test("a binary that could not be launched is named by its error, not a negative exit code", () => {
  // Node closes a process it failed to spawn with the negative error number as its
  // exit code (-2 for ENOENT on macOS and Linux, -4058 on Windows)
  const errno = (name) => [...getSystemErrorMap()].find(([, [code]]) => code === name)[0];
  assert.equal(extractReason({ exitCode: errno("ENOENT") }), "could not launch (ENOENT)");
  assert.equal(extractReason({ exitCode: errno("EACCES") }), "could not launch (EACCES)");
});

test("reads only the last 16 KB, so a long-running server's old lines are ignored", () => {
  const stderr =
    "error: failed to read WAV file 'old.wav'\n" +
    "whisper_print_timings:    total time =    10.00 ms\n".repeat(400);
  assert.ok(stderr.length > 16 * 1024);
  assert.equal(extractReason({ stderr, exitCode: 3221225477 }), "exit code 0xC0000005");
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
    "error: failed to read '~\\a.wav"
  );
  assert.equal(
    extractReason({ stderr: "error: failed to read 'C:/Users/Mika/a.wav'", homeDir }),
    "error: failed to read '~/a.wav"
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

test("the reason never closes a quote that an earlier .env line left open", () => {
  // A backtick hotkey is saved as DICTATION_KEY=`. A reason whose only backtick
  // ends the line would close that quote, and the hotkey would swallow every key
  // down to the reason, the failure flag included.
  for (const quote of ["'", '"', "`"]) {
    const reason = extractReason({
      stderr: `exception during model load: ${quote}vkCreateDevice failed${quote}`,
      homeDir: null,
    });
    const env = parseDotenv(
      `DICTATION_KEY=${quote}\nWHISPER_GPU_FAILED=vulkan\nWHISPER_GPU_FAILED_REASON_VULKAN=${reason}\n`
    );
    assert.equal(reason, "vkCreateDevice failed", quote);
    assert.equal(env.DICTATION_KEY, quote, `${quote}: the hotkey swallowed the keys after it`);
    assert.equal(env.WHISPER_GPU_FAILED, "vulkan", quote);
    assert.equal(env.WHISPER_GPU_FAILED_REASON_VULKAN, reason, quote);
  }
});
