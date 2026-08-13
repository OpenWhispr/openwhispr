const { execFile } = require("child_process");

// The shipped CUDA whisper build (release 0.0.9) carries kernels for Pascal
// (compute capability 6.1) and newer; 6.1's embedded PTX also covers Volta via
// driver JIT. On cards below the floor the server starts, loads the model into
// VRAM, then aborts on the first kernel launch with "no kernel image is
// available for execution on the device" — so those cards must be offered
// Vulkan instead, which works on any NVIDIA GPU. Keep this floor in lockstep
// with CUDA_ARCHITECTURES in OpenWhispr/whisper.cpp's build-binaries.yml.
const MIN_CUDA_COMPUTE_CAP = 6.1;

let cachedGpuInfo = null;

function queryNvidiaSmi(fields) {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=" + fields, "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => resolve(error || !stdout ? null : stdout)
    );
  });
}

function parseNvidiaSmiGpuInfo(stdout) {
  const parts = stdout
    .trim()
    .split("\n")[0]
    .split(",")
    .map((s) => s.trim());
  if (parts.length < 3) return { hasNvidiaGpu: false };

  const computeCap = parts.length >= 4 ? parseFloat(parts[3]) : NaN;
  return {
    hasNvidiaGpu: true,
    gpuName: parts[0],
    driverVersion: parts[1],
    vramMb: parseInt(parts[2], 10) || undefined,
    ...(Number.isFinite(computeCap) ? { computeCap } : {}),
    cudaSupported: Number.isFinite(computeCap) && computeCap >= MIN_CUDA_COMPUTE_CAP,
  };
}

async function detectNvidiaGpu() {
  if (cachedGpuInfo) return cachedGpuInfo;

  if (process.platform === "darwin") {
    cachedGpuInfo = { hasNvidiaGpu: false };
    return cachedGpuInfo;
  }

  let stdout = await queryNvidiaSmi("name,driver_version,memory.total,compute_cap");
  if (stdout === null) {
    // Drivers too old to answer the compute_cap query (pre-R470) also predate
    // the CUDA 12 runtime the pack ships with, so cudaSupported stays false.
    stdout = await queryNvidiaSmi("name,driver_version,memory.total");
  }

  cachedGpuInfo = stdout === null ? { hasNvidiaGpu: false } : parseNvidiaSmiGpuInfo(stdout);
  return cachedGpuInfo;
}

let cachedGpuList = null;

function listNvidiaGpus() {
  if (cachedGpuList) return Promise.resolve(cachedGpuList);

  if (process.platform === "darwin") {
    cachedGpuList = [];
    return Promise.resolve(cachedGpuList);
  }

  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          cachedGpuList = [];
          resolve(cachedGpuList);
          return;
        }

        const gpus = stdout
          .trim()
          .split("\n")
          .map((line) => {
            const parts = line.split(",").map((s) => s.trim());
            return {
              index: parseInt(parts[0], 10),
              uuid: parts[1] || "",
              name: parts[2] || "Unknown GPU",
              vramMb: parseInt(parts[3], 10) || 0,
            };
          })
          .filter((g) => !isNaN(g.index));

        if (gpus.length > 0) cachedGpuList = gpus;
        resolve(gpus);
      }
    );
  });
}

module.exports = { detectNvidiaGpu, listNvidiaGpus, parseNvidiaSmiGpuInfo, MIN_CUDA_COMPUTE_CAP };
