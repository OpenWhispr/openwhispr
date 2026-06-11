const { execFile } = require("child_process");

let cachedGpuInfo = null;
let cachedAmdGpuInfo = null;
let cachedIntelGpuInfo = null;
let cachedVulkanGpuInfo = null;

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

function detectAmdGpu() {
  if (cachedAmdGpuInfo) return Promise.resolve(cachedAmdGpuInfo);

  if (process.platform === "darwin") {
    cachedAmdGpuInfo = { hasAmdGpu: false };
    return Promise.resolve(cachedAmdGpuInfo);
  }

  // On Linux, use lspci to detect AMD/ATI GPUs
  if (process.platform === "linux") {
    return new Promise((resolve) => {
      execFile("lspci", { timeout: 5000 }, (error, stdout) => {
        if (error || !stdout) {
          cachedAmdGpuInfo = { hasAmdGpu: false };
          resolve(cachedAmdGpuInfo);
          return;
        }

        // Match AMD/ATI VGA or 3D controller lines
        const amdLines = stdout
          .split("\n")
          .filter(
            (line) =>
              (line.includes("VGA") || line.includes("3D controller")) &&
              (line.includes("AMD") || line.includes("ATI"))
          );

        if (amdLines.length === 0) {
          cachedAmdGpuInfo = { hasAmdGpu: false };
          resolve(cachedAmdGpuInfo);
          return;
        }

        // Extract GPU name from first match
        const match = amdLines[0].match(
          /(?:VGA compatible controller|3D controller):\s*(?:Advanced Micro Devices, Inc\.\s*\[AMD(?:\/ATI)?\]\s*)?(.+?)(?:\s*\(rev [0-9a-f]+\))?$/i
        );
        const gpuName = match ? match[1].trim() : "AMD GPU";

        cachedAmdGpuInfo = {
          hasAmdGpu: true,
          gpuName,
        };
        resolve(cachedAmdGpuInfo);
      });
    });
  }

  // On Windows, use WMIC to detect AMD GPUs
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "wmic",
        ["path", "win32_videocontroller", "get", "name,adapterram", "/format:csv"],
        { timeout: 5000 },
        (error, stdout) => {
          if (error || !stdout) {
            cachedAmdGpuInfo = { hasAmdGpu: false };
            resolve(cachedAmdGpuInfo);
            return;
          }

          const lines = stdout
            .trim()
            .split("\n")
            .filter((line) => line.toLowerCase().includes("amd") || line.toLowerCase().includes("radeon"));

          if (lines.length === 0) {
            cachedAmdGpuInfo = { hasAmdGpu: false };
            resolve(cachedAmdGpuInfo);
            return;
          }

          // CSV format: Node,AdapterRAM,Name
          const parts = lines[0].split(",");
          const gpuName = parts[parts.length - 1]?.trim() || "AMD GPU";
          const adapterRam = parseInt(parts[parts.length - 2], 10) || 0;

          cachedAmdGpuInfo = {
            hasAmdGpu: true,
            gpuName,
            vramMb: adapterRam > 0 ? Math.round(adapterRam / (1024 * 1024)) : undefined,
          };
          resolve(cachedAmdGpuInfo);
        }
      );
    });
  }

  cachedAmdGpuInfo = { hasAmdGpu: false };
  return Promise.resolve(cachedAmdGpuInfo);
}

function detectIntelGpu() {
  if (cachedIntelGpuInfo) return Promise.resolve(cachedIntelGpuInfo);

  if (process.platform === "darwin") {
    cachedIntelGpuInfo = { hasIntelGpu: false };
    return Promise.resolve(cachedIntelGpuInfo);
  }

  // On Linux, use lspci to detect Intel GPUs (integrated Iris/UHD or discrete Arc)
  if (process.platform === "linux") {
    return new Promise((resolve) => {
      execFile("lspci", { timeout: 5000 }, (error, stdout) => {
        if (error || !stdout) {
          cachedIntelGpuInfo = { hasIntelGpu: false };
          resolve(cachedIntelGpuInfo);
          return;
        }

        const intelLines = stdout
          .split("\n")
          .filter(
            (line) =>
              (line.includes("VGA") || line.includes("3D controller")) &&
              line.includes("Intel")
          );

        if (intelLines.length === 0) {
          cachedIntelGpuInfo = { hasIntelGpu: false };
          resolve(cachedIntelGpuInfo);
          return;
        }

        const match = intelLines[0].match(
          /(?:VGA compatible controller|3D controller):\s*(?:Intel Corporation\s*)?(.+?)(?:\s*\(rev [0-9a-f]+\))?$/i
        );
        const gpuName = match ? match[1].trim() : "Intel GPU";

        cachedIntelGpuInfo = {
          hasIntelGpu: true,
          gpuName,
        };
        resolve(cachedIntelGpuInfo);
      });
    });
  }

  // On Windows, use WMIC to detect Intel GPUs
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "wmic",
        ["path", "win32_videocontroller", "get", "name,adapterram", "/format:csv"],
        { timeout: 5000 },
        (error, stdout) => {
          if (error || !stdout) {
            cachedIntelGpuInfo = { hasIntelGpu: false };
            resolve(cachedIntelGpuInfo);
            return;
          }

          const lines = stdout
            .trim()
            .split("\n")
            .filter((line) => {
              const lower = line.toLowerCase();
              return (
                lower.includes("intel") &&
                (lower.includes("graphics") ||
                  lower.includes("arc") ||
                  lower.includes("iris") ||
                  lower.includes("uhd") ||
                  lower.includes("hd graphics"))
              );
            });

          if (lines.length === 0) {
            cachedIntelGpuInfo = { hasIntelGpu: false };
            resolve(cachedIntelGpuInfo);
            return;
          }

          // CSV format: Node,AdapterRAM,Name
          const parts = lines[0].split(",");
          const gpuName = parts[parts.length - 1]?.trim() || "Intel GPU";
          const adapterRam = parseInt(parts[parts.length - 2], 10) || 0;

          cachedIntelGpuInfo = {
            hasIntelGpu: true,
            gpuName,
            vramMb: adapterRam > 0 ? Math.round(adapterRam / (1024 * 1024)) : undefined,
          };
          resolve(cachedIntelGpuInfo);
        }
      );
    });
  }

  cachedIntelGpuInfo = { hasIntelGpu: false };
  return Promise.resolve(cachedIntelGpuInfo);
}

// Combined detector for any Vulkan-capable GPU (AMD or Intel).
// NVIDIA is intentionally excluded — CUDA is preferred there.
async function detectVulkanCapableGpu() {
  if (cachedVulkanGpuInfo) return cachedVulkanGpuInfo;

  const [amd, intel] = await Promise.all([detectAmdGpu(), detectIntelGpu()]);

  if (amd.hasAmdGpu) {
    cachedVulkanGpuInfo = {
      hasVulkanGpu: true,
      vendor: "amd",
      gpuName: amd.gpuName,
      vramMb: amd.vramMb,
    };
  } else if (intel.hasIntelGpu) {
    cachedVulkanGpuInfo = {
      hasVulkanGpu: true,
      vendor: "intel",
      gpuName: intel.gpuName,
      vramMb: intel.vramMb,
    };
  } else {
    cachedVulkanGpuInfo = { hasVulkanGpu: false };
  }
  return cachedVulkanGpuInfo;
}

module.exports = {
  detectNvidiaGpu,
  listNvidiaGpus,
  detectAmdGpu,
  detectIntelGpu,
  detectVulkanCapableGpu,
};
