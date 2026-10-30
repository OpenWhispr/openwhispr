const { execFile } = require("child_process");

// The Snapdragon gate (win32 + arm64) alone can be true on machines whose
// ARM64 cores are not Qualcomm's, and x64-under-emulation never reaches the
// NPU anyway. The Hexagon NPU only exists under a Qualcomm processor, so the
// pickers that offer NPU models ask WMI for the CPU name and match the vendor
// names Qualcomm ships ("Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) ...").
// A false negative costs nothing (the llama.cpp tab stays); a false positive
// would offer inference that cannot run.

const QUALCOMM_CPU_PATTERN = /snapdragon|qualcomm/i;

function isQualcommCpuName(name) {
  return QUALCOMM_CPU_PATTERN.test(String(name || ""));
}

// PowerShell's CIM cmdlet: wmic is gone from Windows 11 (see gpuDetection.js).
function queryWmiProcessorName(execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name",
      ],
      { timeout: 15000, windowsHide: true },
      (error, stdout) => resolve({ error, stdout: stdout || "" })
    );
  });
}

let cachedCpuInfo;

/**
 * Whether this machine runs a Qualcomm (Snapdragon) processor. Cached after
 * the first answer; the CPU does not change mid-session.
 */
async function detectQualcommCpu(deps = {}) {
  if (cachedCpuInfo) return cachedCpuInfo;

  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;

  if (platform !== "win32" || arch !== "arm64") {
    cachedCpuInfo = { qualcommCpu: false, cpuName: null };
    return cachedCpuInfo;
  }

  // Explicit override wins — both to skip the WMI round trip and so tests and
  // support engineers can pin the answer.
  const override = deps.envOverride ?? process.env.OPENWHISPR_QUALCOMM_CPU;
  if (override !== undefined) {
    cachedCpuInfo = {
      qualcommCpu: !/^(0|false|no|off)$/i.test(override),
      cpuName: null,
    };
    return cachedCpuInfo;
  }

  const execFileImpl = deps.execFileImpl || execFile;
  const { error, stdout } = await queryWmiProcessorName(execFileImpl);
  const cpuName = (stdout || "").split(/\r?\n/).find((line) => line.trim().length > 0) || null;
  const qualcommCpu = !error && isQualcommCpuName(cpuName);

  cachedCpuInfo = { qualcommCpu, cpuName };
  return cachedCpuInfo;
}

function resetQualcommCpuCache() {
  cachedCpuInfo = null;
}

module.exports = {
  QUALCOMM_CPU_PATTERN,
  detectQualcommCpu,
  isQualcommCpuName,
  resetQualcommCpuCache,
};
