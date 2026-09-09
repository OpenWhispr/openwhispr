const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  deviceOrder,
  buildDevices,
  runtimeCandidates,
  chooseGPU,
} = require("../../src/helpers/orukeetRuntime");
const catalog = require("../../resources/orukeet/native-runtimes.json");

test("native GPU choice excludes software and preserves the C ABI GPU ordinal", () => {
  const devices = [
    { type: "cpu", index: 0, name: "CPU" },
    { type: "gpu", index: 1, name: "Vulkan0", description: "llvmpipe", memory_free: 100e9 },
    { type: "gpu", index: 2, name: "Vulkan1", description: "NVIDIA RTX", memory_free: 8e9 },
    { type: "integrated-gpu", index: 3, name: "Vulkan2", description: "Intel", memory_free: 16e9 },
  ];
  assert.equal(chooseGPU(devices).gpuIndex, 1);
  assert.equal(chooseGPU(devices, "2").name, "Vulkan2");
  assert.throws(() => chooseGPU(devices.slice(0, 2)), /No hardware GPU/);
  assert.throws(() => chooseGPU(devices, "255"), /unavailable/);
});

test("release bundles include the accelerated SDKs and a separate CPU fallback", () => {
  assert.deepEqual(buildDevices(catalog, "darwin", "arm64"), ["metal", "cpu"]);
  assert.deepEqual(buildDevices(catalog, "darwin", "x64"), ["cpu"]);
  for (const [platform, arch] of [
    ["win32", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ])
    assert.deepEqual(buildDevices(catalog, platform, arch), ["cuda", "vulkan", "cpu"]);
  assert.deepEqual(buildDevices(catalog, "linux", "x64", "cpu"), ["cpu"]);
  assert.throws(() => buildDevices(catalog, "win32", "arm64"), /No pinned/);
});

test("hardware selection handles NVIDIA, AMD, Intel, hybrid and headless machines", () => {
  const order = (gpuDevice) =>
    deviceOrder({ platform: "win32", arch: "x64", gpuInfo: { gpuDevice } });
  assert.deepEqual(order([{ vendorId: 0x10de }]), ["cuda", "vulkan", "cpu"]);
  for (const vendorId of [0x1002, 0x8086])
    assert.deepEqual(order([{ vendorId }]), ["vulkan", "cpu"]);
  assert.deepEqual(
    order([
      { vendorId: 0x8086, active: true },
      { vendorId: 0x10de, active: false },
    ]),
    ["cuda", "vulkan", "cpu"]
  );
  assert.deepEqual(order([]), ["cuda", "vulkan", "cpu"]);
  assert.deepEqual(order([{ vendorId: 0x1414, deviceString: "Microsoft Basic Render Driver" }]), [
    "cuda",
    "vulkan",
    "cpu",
  ]);
  assert.deepEqual(deviceOrder({ platform: "darwin", arch: "arm64", requested: "cpu" }), ["cpu"]);
  assert.throws(() => deviceOrder({ requested: "bogus" }), /Invalid/);
});

test("runtime resolution uses isolated installed SDKs and preserves legacy replay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orukeet-runtime-"));
  const options = { platform: "linux", arch: "x64" };
  try {
    for (const device of ["cuda", "cpu"]) {
      fs.mkdirSync(path.join(root, device, "bin"), { recursive: true });
      fs.writeFileSync(path.join(root, device, "bin/orukeet-sidecar"), "fixture");
    }
    fs.writeFileSync(
      path.join(root, "runtime.json"),
      JSON.stringify({ schema_version: 2, devices: ["cuda", "vulkan", "cpu"] })
    );
    assert.deepEqual(
      runtimeCandidates(root, options).map((v) => v.device),
      ["cuda", "cpu"]
    );
    assert.deepEqual(runtimeCandidates(root, { ...options, requested: "vulkan" }), []);
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin/orukeet-sidecar"), "fixture");
    fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ device: "cpu" }));
    assert.deepEqual(
      runtimeCandidates(root, options).map((v) => v.device),
      ["cpu"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
