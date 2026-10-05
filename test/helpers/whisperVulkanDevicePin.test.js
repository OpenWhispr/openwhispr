const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseVulkanDevices,
  resolveVulkanPinAction,
} = require("../../src/helpers/whisperServer");

// Shape taken from the reporter's 1.8.3 debug log on issue #1606 (whisper.cpp
// GPU pack 0.0.9), with surrounding server noise included on purpose.
const IGPU_FIRST_STDERR = [
  "whisper_init_from_file_with_params_no_state: loading model from '/tmp/ggml-base.bin'",
  "ggml_vulkan: Found 3 Vulkan devices:",
  "ggml_vulkan: 0 = Intel(R) UHD Graphics 770 (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none",
  "ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Ti (NVIDIA) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: KHR_coopmat",
  "ggml_vulkan: 2 = AMD Radeon RX 7900 XTX (AMD proprietary driver) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: KHR_coopmat",
  "whisper_backend_init_gpu: using Vulkan0 backend",
].join("\n");

test("parseVulkanDevices reads index, name, driver, and uma from device lines", () => {
  const devices = parseVulkanDevices(IGPU_FIRST_STDERR);

  assert.deepEqual(devices, [
    { index: 0, name: "Intel(R) UHD Graphics 770", driver: "Intel Corporation", uma: 1 },
    { index: 1, name: "NVIDIA GeForce RTX 4060 Ti", driver: "NVIDIA", uma: 0 },
    { index: 2, name: "AMD Radeon RX 7900 XTX", driver: "AMD proprietary driver", uma: 0 },
  ]);
});

test("parseVulkanDevices returns [] on CUDA/CPU stderr or an empty buffer", () => {
  assert.deepEqual(parseVulkanDevices("whisper_init: using CUDA0 backend"), []);
  assert.deepEqual(parseVulkanDevices(""), []);
  assert.deepEqual(parseVulkanDevices(undefined), []);
});

test("resolveVulkanPinAction pins the first discrete device when an iGPU is device 0", () => {
  const devices = parseVulkanDevices(IGPU_FIRST_STDERR);

  assert.deepEqual(resolveVulkanPinAction({ devices, appliedPin: null }), {
    action: "pin",
    index: 1,
  });
});

test("resolveVulkanPinAction leaves discrete-first, single-device, and all-UMA setups alone", () => {
  const discreteFirst = [
    { index: 0, name: "RTX 4090", driver: "NVIDIA", uma: 0 },
    { index: 1, name: "Intel UHD", driver: "Intel", uma: 1 },
  ];
  const single = [{ index: 0, name: "Intel UHD", driver: "Intel", uma: 1 }];
  const allUma = [
    { index: 0, name: "Intel UHD", driver: "Intel", uma: 1 },
    { index: 1, name: "AMD Radeon 780M", driver: "AMD", uma: 1 },
  ];

  for (const devices of [discreteFirst, single, allUma, []]) {
    assert.deepEqual(resolveVulkanPinAction({ devices, appliedPin: null }), { action: "none" });
  }
});

test("resolveVulkanPinAction clears a persisted pin that no longer resolves", () => {
  const devices = [
    { index: 0, name: "Intel UHD", driver: "Intel", uma: 1 },
    { index: 1, name: "RTX 4060 Ti", driver: "NVIDIA", uma: 0 },
  ];

  assert.deepEqual(resolveVulkanPinAction({ devices, appliedPin: 5 }), { action: "clear" });
});

test("resolveVulkanPinAction keeps a valid applied pin, even on unparseable stderr", () => {
  const devices = [
    { index: 0, name: "Intel UHD", driver: "Intel", uma: 1 },
    { index: 1, name: "RTX 4060 Ti", driver: "NVIDIA", uma: 0 },
  ];

  assert.deepEqual(resolveVulkanPinAction({ devices, appliedPin: 1 }), { action: "none" });
  // Format drift → no devices parsed → never clear a working pin blindly
  assert.deepEqual(resolveVulkanPinAction({ devices: [], appliedPin: 1 }), { action: "none" });
});
