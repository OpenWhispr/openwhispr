const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const { readActiveGpu } = require("../utils/vulkanDetection");

// What the local-onboarding screen needs to know about this computer. Every read
// is independent and fails soft: a missing tool, a timeout or garbled output
// leaves that one field null (or its default) and never stops the others.

const SYSTEM_PROFILER_TIMEOUT_MS = 10000;
const POWERSHELL_TIMEOUT_MS = 15000;

const PLACEHOLDER =
  /to be filled|system (product name|manufacturer)|default string|not applicable|^none$|^$/i;

const MAKER_NAMES = [
  [/ASUSTeK/i, "ASUS"],
  [/Hewlett[- ]Packard/i, "HP"],
  [/Micro-Star/i, "MSI"],
];

// One PowerShell call for everything the Windows name and form factor need.
const WINDOWS_HARDWARE_SCRIPT = [
  "$cs = Get-CimInstance Win32_ComputerSystem",
  "$csp = Get-CimInstance Win32_ComputerSystemProduct",
  "[pscustomobject]@{",
  "Manufacturer = $cs.Manufacturer;",
  "Model = $cs.Model;",
  "PCSystemType = $cs.PCSystemType;",
  "Version = $csp.Version;",
  "Batteries = @(Get-CimInstance Win32_Battery).Count",
  "} | ConvertTo-Json -Compress",
].join("\n");

let profilePromise = null;

function clearCache() {
  profilePromise = null;
}

function cleanProcessorName(raw) {
  return String(raw ?? "")
    .replace(/^\d+(st|nd|rd|th) Gen\s+/i, "")
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\s+@\s*[\d.]+\s*GHz.*$/i, "")
    .replace(/\s+CPU\b.*$/i, "")
    .replace(/\s+with\s+Radeon.*$/i, "")
    .replace(/\s+\d+-Core Processor$/i, "")
    .replace(/\s+Processor$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAppleChip(raw) {
  const match = String(raw ?? "").match(/^Apple M(\d+)(?:\s+(Pro|Max|Ultra))?\b/i);
  if (!match) return null;
  const tier = match[2] ? match[2][0].toUpperCase() + match[2].slice(1).toLowerCase() : "";
  return { generation: Number(match[1]), tier };
}

function usable(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return PLACEHOLDER.test(text) ? null : text;
}

function cleanMaker(raw) {
  const text = usable(raw);
  if (!text) return null;
  for (const [pattern, name] of MAKER_NAMES) if (pattern.test(text)) return name;
  const stripped = text
    .replace(/,?\s*\b(Co\.,?\s*Ltd\.?|Inc\.?|Corporation|Corp\.?|Ltd\.?)(?=\s|,|$)/gi, "")
    .replace(/[\s,]+$/, "")
    .trim();
  if (!stripped) return null;
  // "LENOVO" and "DELL" are the makers shouting; "HP" and "MSI" are the brand
  if (stripped === stripped.toUpperCase() && stripped.length > 3) {
    return stripped.replace(/\b(\w)(\w*)/g, (_, first, rest) => first + rest.toLowerCase());
  }
  return stripped;
}

// "Dell Inc." + "XPS 13 9310" -> "Dell XPS 13 9310". null when the firmware left
// its placeholder text in, so the screen falls back to the generic name.
function makerModelName({ maker, model, version } = {}) {
  const cleanedMaker = cleanMaker(maker);
  // Lenovo's `model` is a machine-type code ("21AH00FKUS"); the readable name is `version`
  const rawModel = cleanedMaker === "Lenovo" ? usable(version) : usable(model);
  if (!rawModel) return null;
  const cleanedModel = rawModel.replace(/\s+(Notebook|Laptop) PC$/i, "").trim();
  if (!cleanedModel) return null;
  if (!cleanedMaker) return cleanedModel;
  if (cleanedModel.toLowerCase().startsWith(cleanedMaker.toLowerCase())) return cleanedModel;
  return `${cleanedMaker} ${cleanedModel}`;
}

// Chromium's renderer string leaves marks and API detail in; keep the product name.
function cleanGraphicsName(raw) {
  const text = String(raw ?? "")
    .replace(/^ANGLE Metal Renderer:\s*/i, "")
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s+Direct3D\d*.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function run(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    try {
      execFileImpl(file, args, options, (error, stdout) =>
        resolve({ error: error || null, stdout: stdout ? String(stdout) : "" })
      );
    } catch (error) {
      resolve({ error, stdout: "" });
    }
  });
}

async function attempt(read, fallback) {
  try {
    const value = await read();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function resolveDeps(deps) {
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    execFileImpl: deps.execFileImpl ?? execFile,
    fs: deps.fs ?? fs.promises,
    os: deps.os ?? os,
    // Electron and the GPU helpers load on use so injected deps never pull them in
    getGPUInfo: deps.getGPUInfo ?? ((type) => require("electron").app.getGPUInfo(type)),
    detectNvidiaGpu:
      deps.detectNvidiaGpu ?? (() => require("../utils/gpuDetection").detectNvidiaGpu()),
    getParakeetCapability:
      deps.getParakeetCapability ?? (() => require("./parakeetCapability").getParakeetCapability()),
    getPreferredSystemLanguages:
      deps.getPreferredSystemLanguages ??
      (() => require("electron").app.getPreferredSystemLanguages()),
  };
}

const NO_HARDWARE = { name: null, formFactor: "desktop", chipName: null };

async function readMacHardware(d) {
  const { error, stdout } = await run(
    d.execFileImpl,
    "/usr/sbin/system_profiler",
    ["SPHardwareDataType", "-json"],
    { timeout: SYSTEM_PROFILER_TIMEOUT_MS }
  );
  if (error) return NO_HARDWARE;
  const hardware = JSON.parse(stdout)?.SPHardwareDataType?.[0];
  const machineName = usable(hardware?.machine_name);
  return {
    name: machineName,
    formFactor: machineName && /^MacBook/i.test(machineName) ? "laptop" : "desktop",
    chipName: usable(hardware?.chip_type) || usable(hardware?.cpu_type),
  };
}

async function readWindowsHardware(d) {
  const { error, stdout } = await run(
    d.execFileImpl,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_HARDWARE_SCRIPT],
    { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true }
  );
  if (error) return NO_HARDWARE;
  const hardware = JSON.parse(stdout);
  // PCSystemType 2 is "Mobile". A desktop with a UPS plugged in can also list a battery,
  // but a laptop wrongly told it is a desktop is the likelier miss.
  const isLaptop = hardware.PCSystemType === 2 || Number(hardware.Batteries) > 0;
  return {
    name: makerModelName({
      maker: hardware.Manufacturer,
      model: hardware.Model,
      version: hardware.Version,
    }),
    formFactor: isLaptop ? "laptop" : "desktop",
    chipName: null,
  };
}

async function readLinuxHardware(d) {
  const readDmi = (field) =>
    attempt(async () => String(await d.fs.readFile(`/sys/class/dmi/id/${field}`, "utf8")), "");
  const [maker, model, version, supplies] = await Promise.all([
    readDmi("sys_vendor"),
    readDmi("product_name"),
    readDmi("product_version"),
    attempt(() => d.fs.readdir("/sys/class/power_supply"), []),
  ]);
  return {
    name: makerModelName({ maker, model, version }),
    formFactor: Array.from(supplies).some((entry) => /^BAT/i.test(String(entry)))
      ? "laptop"
      : "desktop",
    chipName: null,
  };
}

function readHardware(d) {
  if (d.platform === "darwin") return readMacHardware(d);
  if (d.platform === "win32") return readWindowsHardware(d);
  if (d.platform === "linux") return readLinuxHardware(d);
  return NO_HARDWARE;
}

async function readNvidia(d) {
  if (d.platform === "darwin") return null;
  const info = await d.detectNvidiaGpu();
  if (!info?.hasNvidiaGpu) return null;
  return { name: info.gpuName || "NVIDIA GPU", vramMb: info.vramMb ?? null };
}

function baseLanguage(languages) {
  const first = Array.isArray(languages) ? languages[0] : null;
  const base = typeof first === "string" ? first.split(/[-_]/)[0].trim().toLowerCase() : "";
  return base || "en";
}

async function buildProfile(d) {
  const [hardware, cpuModel, nvidia, memoryGb, parakeetSupported, systemLanguage] =
    await Promise.all([
      attempt(() => readHardware(d), NO_HARDWARE),
      attempt(() => d.os.cpus()[0]?.model, ""),
      attempt(() => readNvidia(d), null),
      attempt(() => Math.round(d.os.totalmem() / 2 ** 30), 0),
      attempt(() => d.getParakeetCapability().supported === true, false),
      attempt(async () => baseLanguage(await d.getPreferredSystemLanguages()), "en"),
    ]);

  const processorName = cleanProcessorName(cpuModel) || cleanProcessorName(hardware.chipName);
  const appleChip = parseAppleChip(processorName);
  // Apple silicon has no separate graphics to name; an unreadable chip on arm64 is still one
  const onAppleChip = Boolean(appleChip) || (d.platform === "darwin" && d.arch === "arm64");

  let graphicsName = null;
  if (!onAppleChip) {
    graphicsName = nvidia
      ? nvidia.name
      : await attempt(async () => {
          const gpu = await readActiveGpu({ getGPUInfo: d.getGPUInfo });
          return cleanGraphicsName(gpu?.deviceName);
        }, null);
  }

  return {
    platform: d.platform,
    arch: d.arch,
    name: hardware.name,
    formFactor: hardware.formFactor,
    processorName,
    appleChip,
    memoryGb,
    graphicsName,
    nvidia,
    parakeetSupported,
    systemLanguage,
  };
}

// Read once per process; the answer does not change while the app runs.
function readComputerProfile(deps = {}) {
  if (!profilePromise) {
    profilePromise = (async () => {
      try {
        return await buildProfile(resolveDeps(deps));
      } catch {
        return {
          platform: deps.platform ?? process.platform,
          arch: deps.arch ?? process.arch,
          name: null,
          formFactor: "desktop",
          processorName: "",
          appleChip: null,
          memoryGb: 0,
          graphicsName: null,
          nvidia: null,
          parakeetSupported: false,
          systemLanguage: "en",
        };
      }
    })();
  }
  return profilePromise;
}

module.exports = {
  readComputerProfile,
  cleanProcessorName,
  parseAppleChip,
  makerModelName,
  clearCache,
};
