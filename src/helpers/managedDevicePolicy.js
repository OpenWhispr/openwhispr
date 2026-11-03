const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { isValidPolicyShape } = require("./policyValidation");
const registry = require("../models/modelRegistryData.json");

const execute = promisify(execFile);
const DEVICE_KEYS = [
  "Policy",
  "RequireSignIn",
  "AuditLogPath",
  "WipeLocalDataOnLaunch",
  "DisableMeetingRecording",
];
const MAX_POLICY_BYTES = 1024 * 1024;
const MODES = ["openwhispr", "providers", "local", "self-hosted", "enterprise"];

function defaultDevicePolicy() {
  return {
    version: 1,
    transcription: {
      allowedModes: [...MODES],
      allowedByokProviders: [
        ...registry.transcriptionProviders.map((provider) => provider.id),
        "custom",
      ],
      allowedEnterpriseProviders: ["azure", "openai-compatible"],
    },
    llm: {
      allowedModes: [...MODES],
      allowedByokProviders: [
        ...registry.cloudProviders.map((provider) => provider.id),
        "openrouter",
        "custom",
      ],
      allowedEnterpriseProviders: ["bedrock", "azure", "vertex"],
    },
    features: {
      agentEnabled: true,
      webSearchEnabled: true,
      screenContextEnabled: true,
      connectorsEnabled: true,
      meetingRecordingEnabled: true,
      audioUploadEnabled: true,
    },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    requiredLocalModels: [],
    minAppVersion: null,
    updates: { mode: "user_choice" },
  };
}

function knownKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function normalizeDeviceValues(values) {
  if (!knownKeys(values, DEVICE_KEYS)) throw new Error("Invalid device settings");
  if (
    Object.keys(values).length === 0 ||
    (Object.keys(values).length === 1 && values.DisableMeetingRecording === false)
  ) {
    return {
      status: "absent",
      managed: false,
      policy: null,
      requireSignIn: false,
      localOnly: false,
    };
  }
  for (const key of ["RequireSignIn", "DisableMeetingRecording"]) {
    if (values[key] !== undefined && typeof values[key] !== "boolean")
      throw new Error("Invalid device boolean");
  }
  for (const key of ["AuditLogPath", "WipeLocalDataOnLaunch"]) {
    if (values[key] !== undefined && (typeof values[key] !== "string" || !values[key].trim())) {
      throw new Error("Invalid device string");
    }
  }
  const hasPolicy = Object.hasOwn(values, "Policy");
  let policy = defaultDevicePolicy();
  if (hasPolicy) {
    if (typeof values.Policy !== "string" || Buffer.byteLength(values.Policy) > MAX_POLICY_BYTES) {
      throw new Error("Invalid policy string");
    }
    policy = JSON.parse(values.Policy);
    if (
      !isValidPolicyShape(policy) ||
      !knownKeys(policy, [
        "version",
        "transcription",
        "llm",
        "features",
        "sharing",
        "dataRetention",
        "requiredLocalModels",
        "minAppVersion",
        "updates",
      ]) ||
      !knownKeys(policy.transcription, [
        "allowedModes",
        "allowedByokProviders",
        "allowedEnterpriseProviders",
      ]) ||
      !knownKeys(policy.llm, [
        "allowedModes",
        "allowedByokProviders",
        "allowedEnterpriseProviders",
      ]) ||
      !knownKeys(policy.features, [
        "agentEnabled",
        "webSearchEnabled",
        "screenContextEnabled",
        "connectorsEnabled",
        "meetingRecordingEnabled",
        "audioUploadEnabled",
        "memoryEnabled",
      ]) ||
      !knownKeys(policy.sharing, ["externalLinkSharing"]) ||
      !knownKeys(policy.dataRetention, [
        "audioRetentionMaxDays",
        "localHistoryMode",
        "cloudBackupAllowed",
      ])
    ) {
      throw new Error("Unsupported or malformed policy");
    }
    if (
      policy.updates !== undefined &&
      (!knownKeys(policy.updates, ["mode"]) ||
        (policy.updates.mode !== undefined && typeof policy.updates.mode !== "string"))
    ) {
      throw new Error("Invalid update policy");
    }
    policy.updates = {
      mode: ["always_on", "it_managed"].includes(policy.updates?.mode)
        ? policy.updates.mode
        : "user_choice",
    };
  }
  if (values.DisableMeetingRecording === true) policy.features.meetingRecordingEnabled = false;
  return {
    status: "valid",
    managed: true,
    policy,
    requireSignIn: values.RequireSignIn ?? hasPolicy,
    localOnly: values.RequireSignIn === false,
    auditLogPath: values.AuditLogPath ?? null,
    wipeLocalDataOnLaunch: values.WipeLocalDataOnLaunch ?? null,
  };
}

async function readTrustedJson(filePath, { fileSystem = fs.promises, ownerId = 0 } = {}) {
  let handle;
  try {
    handle = await fileSystem.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== ownerId ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > MAX_POLICY_BYTES
    ) {
      throw new Error("Untrusted policy file");
    }
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_POLICY_BYTES) throw new Error("Policy file exceeds limit");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readLinuxValues({
  directory = "/etc/openwhispr",
  fileSystem = fs.promises,
  ownerId = 0,
} = {}) {
  try {
    const stat = await fileSystem.lstat(directory);
    const parent = await fileSystem.stat(path.dirname(directory));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== ownerId ||
      (stat.mode & 0o022) !== 0 ||
      parent.uid !== ownerId ||
      (parent.mode & 0o022) !== 0
    )
      throw new Error("Untrusted policy directory");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const [policy, device] = await Promise.all([
    readTrustedJson(path.join(directory, "policy.json"), { fileSystem, ownerId }),
    readTrustedJson(path.join(directory, "device.json"), { fileSystem, ownerId }),
  ]);
  if (
    device !== undefined &&
    !knownKeys(
      device,
      DEVICE_KEYS.filter((key) => key !== "Policy")
    )
  ) {
    throw new Error("Invalid Linux device settings");
  }
  return { ...device, ...(policy === undefined ? {} : { Policy: JSON.stringify(policy) }) };
}

const WINDOWS_READER = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$key = $base.OpenSubKey('SOFTWARE\\Policies\\OpenWhispr')
$result = @{}
try {
  if ($null -ne $key) {
    foreach ($name in @('Policy','RequireSignIn','AuditLogPath','WipeLocalDataOnLaunch','DisableMeetingRecording')) {
      if ($key.GetValueNames() -contains $name) {
        $result[$name] = @{ kind = $key.GetValueKind($name).ToString(); value = $key.GetValue($name) }
      }
    }
  }
  ConvertTo-Json -InputObject $result -Compress -Depth 4
} finally { if ($null -ne $key) { $key.Dispose() }; $base.Dispose() }
`;

async function readWindowsValues(run = execute) {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_READER, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: MAX_POLICY_BYTES * 2 + 4096 }
  );
  const raw = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!knownKeys(raw, DEVICE_KEYS)) throw new Error("Invalid registry response");
  return Object.fromEntries(
    Object.entries(raw).map(([key, entry]) => {
      const boolean = ["RequireSignIn", "DisableMeetingRecording"].includes(key);
      if (
        boolean
          ? entry.kind !== "DWord" || ![0, 1].includes(entry.value)
          : entry.kind !== "String" || typeof entry.value !== "string"
      ) {
        throw new Error("Invalid registry value type");
      }
      return [key, boolean ? entry.value === 1 : entry.value];
    })
  );
}

async function readDeviceValues({ platform = process.platform, run = execute, linux = {} } = {}) {
  if (platform === "linux") return readLinuxValues(linux);
  if (platform === "win32") return readWindowsValues(run);
  if (platform !== "darwin") return {};
  const binary = require("./binaryResolver").resolveBundledBinary("macos-managed-policy", "policy");
  if (!binary) throw new Error("Managed policy reader unavailable");
  const { stdout } = await run(binary, [], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: MAX_POLICY_BYTES * 2 + 4096,
  });
  return JSON.parse(stdout);
}

function createManagedDevicePolicy({
  read = readDeviceValues,
  refreshMs = 60_000,
  platform = process.platform,
} = {}) {
  let snapshot = { status: "loading", managed: false, policy: null, revision: 0 };
  let sequence = 0;
  let timer;
  let refreshTimer;
  const watchers = new Map();
  function watchPolicyDirectory() {
    if (platform !== "linux" && platform !== "darwin") return;
    const parent = platform === "linux" ? "/etc" : "/Library";
    const name = platform === "linux" ? "openwhispr" : "Managed Preferences";
    for (const directory of [parent, path.join(parent, name)]) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = fs.watch(
          directory,
          { persistent: false, recursive: platform === "darwin" && directory !== parent },
          (_event, filename) => {
            if (directory === parent && filename !== name) return;
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
              watchPolicyDirectory();
              void refresh();
            }, 100);
            refreshTimer.unref?.();
          }
        );
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(directory);
        });
        watchers.set(directory, watcher);
      } catch {
        /* Polling also detects a policy directory created after startup. */
      }
    }
  }
  const listeners = new Set();
  async function refresh() {
    const request = ++sequence;
    let next;
    try {
      next = normalizeDeviceValues(await read());
    } catch {
      next = {
        status: "invalid",
        managed: true,
        policy: null,
        requireSignIn: false,
        localOnly: false,
        code: "DEVICE_POLICY_INVALID",
      };
    }
    if (request !== sequence) return snapshot;
    const previous = { ...snapshot };
    delete previous.revision;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      snapshot = { ...next, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener(snapshot);
    }
    return snapshot;
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      watchPolicyDirectory();
      if (!timer) {
        timer = setInterval(() => {
          watchPolicyDirectory();
          void refresh();
        }, refreshMs);
        timer.unref?.();
      }
      return refresh();
    },
    stop() {
      sequence += 1;
      clearInterval(timer);
      clearTimeout(refreshTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      timer = null;
      listeners.clear();
    },
  };
}

module.exports = {
  createManagedDevicePolicy,
  defaultDevicePolicy,
  normalizeDeviceValues,
  readDeviceValues,
  readLinuxValues,
  readWindowsValues,
};
