const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const debugLogger = require("./debugLogger");
const { isValidPolicyShape } = require("./policyValidation");
const { registryData } = require("../models/registryData.js");

const execute = promisify(execFile);
const DEVICE_KEYS = [
  "Policy",
  "RequireSignIn",
  "AuditLogPath",
  "WipeLocalDataOnLaunch",
  "WipeLocalDataIncludesModels",
  "DisableMeetingRecording",
];
const BOOLEAN_DEVICE_KEYS = [
  "RequireSignIn",
  "WipeLocalDataIncludesModels",
  "DisableMeetingRecording",
];
const MAX_POLICY_BYTES = 1024 * 1024;
const MODES = ["openwhispr", "providers", "local", "self-hosted", "enterprise"];
const FOCUS_REFRESH_THROTTLE_MS = 30 * 1000;
const LINUX_POLICY_DIRECTORY = "/etc/openwhispr";
const MACOS_PREFERENCES_DOMAIN = "com.gizmolabs.openwhispr";
const WINDOWS_POLICIES_KEY = "HKLM\\SOFTWARE\\Policies";
const WINDOWS_POLICY_KEY = `${WINDOWS_POLICIES_KEY}\\OpenWhispr`;
const READER_TIMEOUT_MS = 5000;

function defaultDevicePolicy() {
  return {
    version: 1,
    transcription: {
      allowedModes: [...MODES],
      allowedByokProviders: [
        ...registryData.transcriptionProviders.map((provider) => provider.id),
        "custom",
      ],
      allowedEnterpriseProviders: ["azure", "openai-compatible"],
    },
    llm: {
      allowedModes: [...MODES],
      allowedByokProviders: [
        ...registryData.cloudProviders.map((provider) => provider.id),
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const ABSENT_SNAPSHOT = {
  status: "absent",
  managed: false,
  policy: null,
  requireSignIn: false,
  localOnly: false,
};
// A deployment a reader found and this build rejects (a wrong type or
// shape), as opposed to a reader that couldn't read one.
const invalidDeployment = (message) =>
  Object.assign(new Error(message), { code: "DEVICE_POLICY_INVALID" });
const INVALID_SNAPSHOT = {
  status: "invalid",
  managed: true,
  policy: null,
  requireSignIn: false,
  localOnly: false,
  code: "DEVICE_POLICY_INVALID",
};

// Additive, like the workspace policy: a value or field a later build reads is
// ignored here, while the ones this build knows keep their strict types.
function normalizeDeviceValues(input) {
  if (!isPlainObject(input)) throw new Error("Invalid device settings");
  const values = Object.fromEntries(
    DEVICE_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]])
  );
  // Values that change nothing on their own don't make a device managed: the
  // legacy alias left at false, and the models flag without a wipe token.
  const inert = (key) =>
    (key === "DisableMeetingRecording" && values[key] === false) ||
    (key === "WipeLocalDataIncludesModels" && typeof values[key] === "boolean");
  if (Object.keys(values).every(inert)) return ABSENT_SNAPSHOT;
  for (const key of BOOLEAN_DEVICE_KEYS) {
    if (values[key] !== undefined && typeof values[key] !== "boolean")
      throw new Error("Invalid device boolean");
  }
  for (const key of ["AuditLogPath", "WipeLocalDataOnLaunch"]) {
    if (values[key] !== undefined && (typeof values[key] !== "string" || !values[key].trim()))
      throw new Error("Invalid device string");
  }
  const hasPolicy = Object.hasOwn(values, "Policy");
  let policy = defaultDevicePolicy();
  if (hasPolicy) {
    if (typeof values.Policy !== "string" || Buffer.byteLength(values.Policy) > MAX_POLICY_BYTES) {
      throw new Error("Invalid policy string");
    }
    policy = JSON.parse(values.Policy);
    if (!isValidPolicyShape(policy)) throw new Error("Unsupported or malformed policy");
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
    // Where the meeting audit log is written (meetingAuditLog.js).
    auditLogPath: values.AuditLogPath ?? null,
    // The offboarding wipe's token and whether it takes models (localDataWipe.js).
    wipeLocalDataOnLaunch: values.WipeLocalDataOnLaunch ?? null,
    wipeLocalDataIncludesModels: values.WipeLocalDataIncludesModels ?? false,
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
  directory = LINUX_POLICY_DIRECTORY,
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
  if (device !== undefined && (!isPlainObject(device) || Object.hasOwn(device, "Policy"))) {
    throw invalidDeployment("Invalid Linux device settings");
  }
  return { ...device, ...(policy === undefined ? {} : { Policy: JSON.stringify(policy) }) };
}

function runRegistryTool(run, args) {
  const tool = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  return run(tool, [...args, "/reg:64"], { timeout: READER_TIMEOUT_MS, windowsHide: true });
}

// The Policies key every Windows install has lists the OpenWhispr key when
// one is deployed. reg.exe exits 1 for any failure, a missing key among
// them, so this asks the key that is always there: a query that fails means
// reg.exe itself can't read (an AppLocker rule, a policy against registry
// tools), never that no policy is deployed.
async function hasWindowsPolicyKey(run) {
  const { stdout } = await runRegistryTool(run, ["query", WINDOWS_POLICIES_KEY]);
  const key = WINDOWS_POLICY_KEY.replace(/^HKLM\\/, "HKEY_LOCAL_MACHINE\\").toLowerCase();
  return stdout.split(/\r?\n/).some((line) => line.trim().toLowerCase() === key);
}

const REGISTRY_STRING = /^"((?:[^"\\]|\\.)*)"$/;
const unescapeRegistryString = (value) => value.replace(/\\(.)/g, "$1");

// Reads the key's own values from a .reg export, which (unlike `reg query`)
// keeps non-ASCII text intact: REG_SZ is a quoted string, REG_DWORD is dword:.
function parseRegistryExport(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const values = {};
  for (const line of lines.slice(lines.findIndex((entry) => entry.startsWith("[")) + 1)) {
    if (line.startsWith("[")) break;
    const [, rawName, data] = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line) ?? [];
    // Value names are case-insensitive in the registry.
    const name =
      rawName &&
      DEVICE_KEYS.find(
        (key) => key.toLowerCase() === unescapeRegistryString(rawName).toLowerCase()
      );
    if (!name) continue;
    const boolean = BOOLEAN_DEVICE_KEYS.includes(name);
    const dword = /^dword:([0-9a-f]{8})$/i.exec(data)?.[1];
    const string = REGISTRY_STRING.exec(data)?.[1];
    if (boolean ? !["00000000", "00000001"].includes(dword) : string === undefined)
      throw invalidDeployment("Invalid registry value type");
    values[name] = boolean ? dword === "00000001" : unescapeRegistryString(string);
  }
  return values;
}

// Exports only a key that is there: an export that then fails (its file
// can't be written) is a reader failure, and keep-last-valid applies.
async function readWindowsValues(run = execute) {
  if (!(await hasWindowsPolicyKey(run))) return {};
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openwhispr-policy-"));
  const file = path.join(directory, "policy.reg");
  try {
    await runRegistryTool(run, ["export", WINDOWS_POLICY_KEY, file, "/y"]);
    return parseRegistryExport(await fs.promises.readFile(file, "utf16le"));
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

// Whether an administrator deployed something, read without parsing it: a
// reader that fails only means an invalid policy when one is there.
async function hasPolicyEvidence({
  platform = process.platform,
  run = execute,
  fileSystem = fs.promises,
} = {}) {
  if (platform === "win32") return hasWindowsPolicyKey(run);
  const preferences = `${MACOS_PREFERENCES_DOMAIN}.plist`;
  const files =
    platform === "linux"
      ? ["policy.json", "device.json"].map((name) => path.join(LINUX_POLICY_DIRECTORY, name))
      : platform === "darwin"
        ? [
            path.join("/Library/Managed Preferences", preferences),
            path.join("/Library/Managed Preferences", os.userInfo().username, preferences),
          ]
        : [];
  const found = await Promise.all(
    files.map((file) =>
      fileSystem.lstat(file).then(
        () => true,
        (error) => platform === "linux" && ["EACCES", "EPERM"].includes(error.code)
      )
    )
  );
  return found.includes(true);
}

async function readDeviceValues({ platform = process.platform, run = execute, linux = {} } = {}) {
  if (platform === "linux") return readLinuxValues(linux);
  if (platform === "win32") return readWindowsValues(run);
  if (platform !== "darwin") return {};
  const binary = require("./binaryResolver").resolveBundledBinary("macos-managed-policy", "policy");
  if (!binary) throw new Error("Managed policy reader unavailable");
  const { stdout } = await run(binary, [], {
    encoding: "utf8",
    timeout: READER_TIMEOUT_MS,
    maxBuffer: MAX_POLICY_BYTES * 2 + 4096,
  });
  return JSON.parse(stdout);
}

function createManagedDevicePolicy({
  read = readDeviceValues,
  hasPolicy = hasPolicyEvidence,
  logger = debugLogger,
  refreshMs = 60_000,
  platform = process.platform,
} = {}) {
  let snapshot = { status: "loading", managed: false, policy: null, revision: 0 };
  let sequence = 0;
  let reading = null;
  let lastFocusRefresh = 0;
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
              // A read already under way may have missed this change.
              void Promise.resolve(reading).finally(refresh);
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
  // A reader that fails proves nothing on its own: the policy last read stays
  // in force, and without one only evidence of a deployment means invalid.
  // A deployment this build rejects is invalid at once, as at the next
  // launch. A Linux JSON file that doesn't parse stays a read failure: it may
  // still be being written. Null keeps the snapshot as it is.
  async function readNext() {
    let values;
    try {
      values = await read();
    } catch (error) {
      if (error.code === "DEVICE_POLICY_INVALID") return INVALID_SNAPSHOT;
      if (snapshot.status === "valid") {
        logger.warn("Device policy could not be re-read; keeping the last one", {
          error: error.message,
        });
        return null;
      }
      const deployed = await hasPolicy().catch(() => null);
      if (deployed) return INVALID_SNAPSHOT;
      logger.warn(
        deployed === false
          ? "Device policy could not be read, and none is deployed"
          : "Device policy could not be read, nor whether one is deployed; none is enforced",
        { error: error.message }
      );
      return ABSENT_SNAPSHOT;
    }
    try {
      return normalizeDeviceValues(values);
    } catch {
      return INVALID_SNAPSHOT;
    }
  }
  function refresh() {
    reading ??= (async () => {
      const request = ++sequence;
      const next = await readNext();
      if (request !== sequence || !next) return snapshot;
      const previous = { ...snapshot };
      delete previous.revision;
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        snapshot = { ...next, revision: snapshot.revision + 1 };
        for (const listener of listeners) listener(snapshot);
      }
      return snapshot;
    })().finally(() => {
      reading = null;
    });
    return reading;
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    refreshOnFocus() {
      const now = Date.now();
      if (now - lastFocusRefresh < FOCUS_REFRESH_THROTTLE_MS) return;
      lastFocusRefresh = now;
      void refresh();
    },
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
  hasPolicyEvidence,
  normalizeDeviceValues,
  readDeviceValues,
  readLinuxValues,
  readWindowsValues,
};
