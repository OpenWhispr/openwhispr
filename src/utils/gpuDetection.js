const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("../helpers/debugLogger");

// The shipped CUDA whisper build (release 0.0.10) carries kernels for Pascal
// (compute capability 6.1) and newer; 6.1's embedded PTX also covers Volta via
// driver JIT. On cards below the floor the server starts, loads the model into
// VRAM, then aborts on the first kernel launch with "no kernel image is
// available for execution on the device" — so those cards must be offered
// Vulkan instead, which works on any NVIDIA GPU. Keep this floor in lockstep
// with CUDA_ARCHITECTURES in OpenWhispr/whisper.cpp's build-binaries.yml.
const MIN_CUDA_COMPUTE_CAP = 6.1;

let cachedGpuInfo = null;
let cachedGpuList = null;
let cachedSmiPath; // undefined = unresolved, null = no nvidia-smi anywhere

function clearCache() {
  cachedGpuInfo = null;
  cachedGpuList = null;
  cachedSmiPath = undefined;
}

function runNvidiaSmi(smiPath, fields, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(
      smiPath,
      ["--query-gpu=" + fields, "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => resolve({ error, stdout: stdout || "" })
    );
  });
}

// DCH/Windows-Update driver installs don't reliably put nvidia-smi on PATH —
// some ship it only in System32, some only inside the DriverStore, and nothing
// a user runs day-to-day (games, CUDA apps) ever needs it, so only detection
// notices. Climb the ladder once and cache the answer. See #1606.
async function resolveNvidiaSmiPath({ execFileImpl = execFile, fsImpl = fs } = {}) {
  if (cachedSmiPath !== undefined) return cachedSmiPath;

  // A probe error other than ENOENT (timeout, driver refusing the query)
  // still proves the binary exists, so the rung is kept.
  const probe = await runNvidiaSmi("nvidia-smi", "name", execFileImpl);
  if (probe.error?.code !== "ENOENT") {
    cachedSmiPath = { smiPath: "nvidia-smi", source: "path" };
    return cachedSmiPath;
  }

  if (process.platform === "win32") {
    debugLogger.debug("nvidia-smi not on PATH, trying System32", { error: probe.error.message });
    const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const system32Smi = path.join(system32, "nvidia-smi.exe");
    if (fsImpl.existsSync(system32Smi)) {
      cachedSmiPath = { smiPath: system32Smi, source: "system32" };
      return cachedSmiPath;
    }

    try {
      const repository = path.join(system32, "DriverStore", "FileRepository");
      const candidates = fsImpl
        .readdirSync(repository)
        .filter((dir) => /^nv/i.test(dir))
        .map((dir) => path.join(repository, dir, "nvidia-smi.exe"))
        .filter((candidate) => fsImpl.existsSync(candidate));
      if (candidates.length > 0) {
        // Several driver generations can coexist; the newest copy is the
        // one belonging to the currently installed driver.
        candidates.sort((a, b) => fsImpl.statSync(b).mtimeMs - fsImpl.statSync(a).mtimeMs);
        cachedSmiPath = { smiPath: candidates[0], source: "driverstore" };
        return cachedSmiPath;
      }
    } catch (error) {
      debugLogger.debug("DriverStore scan for nvidia-smi failed", { error: error.message });
    }
  }

  cachedSmiPath = null;
  return cachedSmiPath;
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

function parseWmiVideoControllers(stdout) {
  return (
    String(stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /NVIDIA|GeForce|Quadro|Tesla/i.test(line)) || null
  );
}

// WMI gives a name but no compute capability, so gate the CUDA pack on
// families that provably sit at or above MIN_CUDA_COMPUTE_CAP: RTX-branded
// cards (Turing+), GTX 10xx (Pascal, the exact floor), GTX 16xx (Turing),
// and the post-Maxwell TITANs. A false negative just gets the Vulkan pack;
// a false positive would crash every transcription at the first kernel
// launch, so anything unproven stays out.
function isCudaCapableGpuName(name) {
  return /\bRTX\b|\bGTX 10\d\d\b|\bGTX 16\d\d\b|\bTITAN (Xp|V|RTX)\b/i.test(String(name || ""));
}

// Last resort when no nvidia-smi exists at all: ask WMI for the display
// adapters. Works with zero NVIDIA tooling installed. wmic is gone from
// Windows 11, so go through PowerShell's CIM cmdlet.
function queryWmiVideoControllers(execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ],
      { timeout: 15000, windowsHide: true },
      (error, stdout) => resolve({ error, stdout: stdout || "" })
    );
  });
}

async function detectNvidiaGpu(deps = {}) {
  if (cachedGpuInfo) return cachedGpuInfo;

  if (process.platform === "darwin") {
    cachedGpuInfo = { hasNvidiaGpu: false };
    return cachedGpuInfo;
  }

  const execFileImpl = deps.execFileImpl || execFile;
  const resolved = await resolveNvidiaSmiPath(deps);
  if (resolved) {
    let { error, stdout } = await runNvidiaSmi(
      resolved.smiPath,
      "name,driver_version,memory.total,compute_cap",
      execFileImpl
    );
    if (error || !stdout) {
      // Drivers too old to answer the compute_cap query (pre-R470) also predate
      // the CUDA 12 runtime the pack ships with, so cudaSupported stays false.
      ({ error, stdout } = await runNvidiaSmi(
        resolved.smiPath,
        "name,driver_version,memory.total",
        execFileImpl
      ));
    }
    if (!error && stdout) {
      cachedGpuInfo = parseNvidiaSmiGpuInfo(stdout);
      debugLogger.info("NVIDIA GPU detection via nvidia-smi", {
        source: resolved.source,
        hasNvidiaGpu: cachedGpuInfo.hasNvidiaGpu,
        cudaSupported: cachedGpuInfo.cudaSupported,
      });
      return cachedGpuInfo;
    }
    debugLogger.warn("nvidia-smi found but its queries failed", {
      source: resolved.source,
      error: error ? error.message : "empty output",
    });
  }

  if (process.platform === "win32") {
    const wmi = await queryWmiVideoControllers(execFileImpl);
    const gpuName = wmi.error ? null : parseWmiVideoControllers(wmi.stdout);
    if (gpuName) {
      cachedGpuInfo = {
        hasNvidiaGpu: true,
        gpuName,
        cudaSupported: isCudaCapableGpuName(gpuName),
        detectionSource: "wmi",
      };
      debugLogger.info("NVIDIA GPU detected via WMI (no nvidia-smi available)", cachedGpuInfo);
      return cachedGpuInfo;
    }
    if (wmi.error) {
      debugLogger.warn("WMI video controller query failed", { error: wmi.error.message });
    }
  }

  cachedGpuInfo = { hasNvidiaGpu: false };
  return cachedGpuInfo;
}

async function listNvidiaGpus(deps = {}) {
  if (cachedGpuList) return cachedGpuList;

  if (process.platform === "darwin") {
    cachedGpuList = [];
    return cachedGpuList;
  }

  // WMI can't supply UUIDs, so on machines where the whole nvidia-smi ladder
  // misses the per-GPU picker simply has no choices to offer.
  const resolved = await resolveNvidiaSmiPath(deps);
  if (!resolved) {
    cachedGpuList = [];
    return cachedGpuList;
  }

  const { error, stdout } = await runNvidiaSmi(
    resolved.smiPath,
    "index,uuid,name,memory.total",
    deps.execFileImpl || execFile
  );
  if (error || !stdout) {
    debugLogger.debug("nvidia-smi GPU list query failed", {
      source: resolved.source,
      error: error ? error.message : "empty output",
    });
    cachedGpuList = [];
    return cachedGpuList;
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
  return gpus;
}

module.exports = {
  detectNvidiaGpu,
  listNvidiaGpus,
  resolveNvidiaSmiPath,
  parseNvidiaSmiGpuInfo,
  parseWmiVideoControllers,
  isCudaCapableGpuName,
  clearCache,
  MIN_CUDA_COMPUTE_CAP,
};
