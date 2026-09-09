const fs = require("node:fs");
const path = require("node:path");

const DEVICES = ["metal", "cuda", "vulkan", "cpu"];

function platformTag(platform, arch) {
  if (!["x64", "arm64"].includes(arch))
    throw new Error(`Unsupported Orukeet architecture: ${arch}`);
  if (platform === "darwin") return `macos_${arch === "arm64" ? "arm64" : "x86_64"}`;
  if (platform === "linux") return `linux_${arch === "arm64" ? "aarch64" : "x86_64"}`;
  if (platform === "win32" && arch === "x64") return "win_amd64";
  throw new Error(`No pinned Orukeet SDK for ${platform}/${arch}`);
}

function deviceOrder({ platform, arch, gpuInfo = null, requested = "auto" }) {
  if (requested !== "auto") {
    if (!DEVICES.includes(requested)) throw new Error("Invalid Orukeet device");
    return [requested];
  }
  if (platform === "darwin") return arch === "arm64" ? ["metal", "cpu"] : ["cpu"];
  const adapters = gpuInfo?.gpuDevice;
  // Electron's renderer device is a hint, not a test that CUDA/Vulkan can load.
  // Unknown/headless hardware still gets a native GPU attempt before CPU.
  if (!Array.isArray(adapters) || adapters.length === 0) return ["cuda", "vulkan", "cpu"];
  const hardware = adapters.filter(
    (gpu) =>
      !/swiftshader|llvmpipe|software|microsoft basic render/i.test(gpu.deviceString || "") &&
      ![0x1414, 0x1ae0, 0x10005].includes(Number(gpu.vendorId))
  );
  if (hardware.some((gpu) => Number(gpu.vendorId) === 0x10de)) return ["cuda", "vulkan", "cpu"];
  if (hardware.length) return ["vulkan", "cpu"];
  // Software rendering does not establish that the machine lacks a discrete GPU.
  return ["cuda", "vulkan", "cpu"];
}

function buildDevices(catalog, platform, arch, requested = "auto") {
  const tag = platformTag(platform, arch);
  const order = deviceOrder({ platform, arch, requested });
  const devices = order.filter((device) => catalog[`asr-nvidia-${device}`]?.platforms[tag]);
  if (!devices.length || (requested === "auto" && !devices.includes("cpu")))
    throw new Error(`No pinned Orukeet SDK for ${platform}/${arch}/${requested}`);
  return devices;
}

function runtimeCandidates(root, options) {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
  const order = deviceOrder(options);
  const executable = options.platform === "win32" ? "orukeet-sidecar.exe" : "orukeet-sidecar";
  const candidates = [];
  for (const device of order) {
    // Version 1 receipts describe one SDK. Version 2 isolates each SDK so its
    // DLLs/plugins can never shadow another device or the portable CPU fallback.
    const dir =
      receipt.schema_version === 2
        ? receipt.devices?.includes(device)
          ? path.join(root, device)
          : null
        : receipt.device === device
          ? root
          : null;
    if (!dir) continue;
    const binary = path.join(dir, "bin", executable);
    if (fs.existsSync(binary)) candidates.push({ device, binary });
  }
  return candidates;
}

function chooseGPU(devices, requestedIndex) {
  const gpus = devices
    .filter((device) => ["gpu", "integrated-gpu"].includes(device.type))
    .map((device, gpuIndex) => ({ ...device, gpuIndex }));
  if (requestedIndex !== undefined) {
    const selected = gpus.find((device) => device.gpuIndex === Number(requestedIndex));
    if (!selected) throw new Error("Requested Orukeet GPU is unavailable");
    return selected;
  }
  const hardware = gpus.filter(
    (device) =>
      !/llvmpipe|lavapipe|swiftshader|software|microsoft basic render/i.test(
        `${device.name} ${device.description}`
      )
  );
  // Prefer a discrete GPU with room for the model, then available memory.
  // gpuIndex is the GPU ordinal expected by the C ABI, not the global device index.
  const score = (device) =>
    Number(device.memory_free) >= 1_500_000_000 && device.type === "gpu" ? 1 : 0;
  hardware.sort(
    (a, b) =>
      score(b) - score(a) ||
      Number(b.memory_free) - Number(a.memory_free) ||
      a.gpuIndex - b.gpuIndex
  );
  if (!hardware.length) throw new Error("No hardware GPU is available for this runtime");
  return hardware[0];
}

module.exports = { DEVICES, platformTag, deviceOrder, buildDevices, runtimeCandidates, chooseGPU };
