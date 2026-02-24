const { execFile } = require("child_process");

let cachedResult = null;

function detectVulkanGpu() {
  if (cachedResult) return Promise.resolve(cachedResult);

  if (process.platform === "darwin") {
    cachedResult = { available: false };
    return Promise.resolve(cachedResult);
  }

  return new Promise((resolve) => {
    execFile("vulkaninfo", ["--summary"], { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout) {
        cachedResult = { available: false };
        resolve(cachedResult);
        return;
      }

      const nameMatch = stdout.match(/deviceName\s*=\s*(.+)/);
      if (nameMatch) {
        cachedResult = { available: true, deviceName: nameMatch[1].trim() };
      } else {
        cachedResult = { available: false };
      }
      resolve(cachedResult);
    });
  });
}

function clearCache() {
  cachedResult = null;
}

module.exports = { detectVulkanGpu, clearCache };
