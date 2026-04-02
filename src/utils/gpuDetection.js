const { execFile } = require("child_process");

let cachedGpuInfo = null;

function detectNvidiaGpu() {
  if (cachedGpuInfo) return Promise.resolve(cachedGpuInfo);

  if (process.platform === "darwin") {
    cachedGpuInfo = { hasNvidiaGpu: false };
    return Promise.resolve(cachedGpuInfo);
  }

  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) {
          cachedGpuInfo = { hasNvidiaGpu: false };
          resolve(cachedGpuInfo);
          return;
        }

        const parts = stdout
          .trim()
          .split(",")
          .map((s) => s.trim());
        if (parts.length < 3) {
          cachedGpuInfo = { hasNvidiaGpu: false };
          resolve(cachedGpuInfo);
          return;
        }

        cachedGpuInfo = {
          hasNvidiaGpu: true,
          gpuName: parts[0],
          driverVersion: parts[1],
          vramMb: parseInt(parts[2], 10) || undefined,
        };
        resolve(cachedGpuInfo);
      }
    );
  });
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
      ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
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
              name: parts[1] || "Unknown GPU",
              vramMb: parseInt(parts[2], 10) || 0,
            };
          })
          .filter((g) => !isNaN(g.index));

        if (gpus.length > 0) cachedGpuList = gpus;
        resolve(gpus);
      }
    );
  });
}

module.exports = { detectNvidiaGpu, listNvidiaGpus };
