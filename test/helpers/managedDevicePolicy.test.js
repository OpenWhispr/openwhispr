const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../../src/models/modelRegistryData.json");
const fs = require("node:fs");
const path = require("node:path");
const {
  createManagedDevicePolicy,
  defaultDevicePolicy,
  hasPolicyEvidence,
  normalizeDeviceValues,
  readLinuxValues,
  readWindowsValues,
} = require("../../src/helpers/managedDevicePolicy");
const adminExport = require("./fixtures/admin-mdm-device-values.json");

test("complete device policy defaults to required sign-in; local-only is explicit", () => {
  const Policy = JSON.stringify(defaultDevicePolicy());
  assert.equal(normalizeDeviceValues({ Policy }).requireSignIn, true);
  const snapshot = normalizeDeviceValues({ Policy, RequireSignIn: false });
  assert.equal(snapshot.localOnly, true);
  assert.equal(snapshot.requireSignIn, false);
});

test("alias-only deployment retains every supported personal provider", () => {
  const { policy } = normalizeDeviceValues({ DisableMeetingRecording: true });
  for (const provider of registry.transcriptionProviders) {
    assert.ok(policy.transcription.allowedByokProviders.includes(provider.id), provider.id);
  }
  for (const provider of registry.cloudProviders) {
    assert.ok(policy.llm.allowedByokProviders.includes(provider.id), provider.id);
  }
  // The app adds OpenRouter transcription on top of the bundled catalog.
  assert.ok(policy.transcription.allowedByokProviders.includes("openrouter"));
});

test("the admin console's export normalizes as encoded", () => {
  const snapshot = normalizeDeviceValues(adminExport);
  assert.equal(snapshot.status, "valid");
  assert.equal(snapshot.localOnly, true);
  assert.equal(snapshot.policy.updates.mode, "it_managed");
  assert.equal(snapshot.policy.transcription.allowedLocalModels, null);
  assert.equal(snapshot.policy.meetings.transcriptionStart, "automatic");
});

test("fields and device values a later build reads are ignored; known ones stay strict", () => {
  const policy = { ...defaultDevicePolicy(), apiAccessEnabled: false };
  policy.features = { ...policy.features, futureFeatureEnabled: false };
  const snapshot = normalizeDeviceValues({ Policy: JSON.stringify(policy), FutureSetting: 1 });
  assert.equal(snapshot.status, "valid");
  assert.equal(snapshot.requireSignIn, true);
  assert.equal(normalizeDeviceValues({ FutureSetting: true }).status, "absent");
  const wrongType = defaultDevicePolicy();
  wrongType.features.connectorsEnabled = "no";
  assert.throws(() => normalizeDeviceValues({ Policy: JSON.stringify(wrongType) }));
});

test("legacy alias works alone and cannot enable meetings denied by Policy", () => {
  const alias = normalizeDeviceValues({ DisableMeetingRecording: true });
  assert.equal(alias.policy.features.meetingRecordingEnabled, false);
  assert.equal(alias.requireSignIn, false);
  const policy = defaultDevicePolicy();
  policy.features.meetingRecordingEnabled = false;
  assert.equal(
    normalizeDeviceValues({ Policy: JSON.stringify(policy), DisableMeetingRecording: false }).policy
      .features.meetingRecordingEnabled,
    false
  );
  assert.equal(normalizeDeviceValues({ DisableMeetingRecording: false }).status, "absent");
});

test("malformed documents, partial policies and wrong device types fail", () => {
  for (const values of [
    { Policy: "{" },
    { Policy: { version: 1 } },
    { Policy: JSON.stringify({ features: { meetingRecordingEnabled: false } }) },
    { RequireSignIn: 0 },
    { DisableMeetingRecording: "true" },
    { WipeLocalDataOnLaunch: "" },
  ])
    assert.throws(() => normalizeDeviceValues(values));
});

test("unknown update mode retains the specified user-choice fallback", () => {
  const policy = defaultDevicePolicy();
  policy.updates.mode = "future_mode";
  assert.equal(
    normalizeDeviceValues({ Policy: JSON.stringify(policy) }).policy.updates.mode,
    "user_choice"
  );
});

// reg.exe without the OpenWhispr key or, `blocked`, unable to read any key.
// It exits 1 either way.
function registryWithoutPolicy({ blocked = false } = {}) {
  return async (_command, args) => {
    if (blocked)
      throw Object.assign(
        new Error("ERROR: Registry editing has been disabled by your administrator."),
        { code: 1 }
      );
    if (args[1].endsWith("\\OpenWhispr"))
      throw Object.assign(new Error("ERROR: The system was unable to find the key."), {
        code: 1,
      });
    return { stdout: "" };
  };
}

// reg.exe writes a .reg export as UTF-16 with a byte order mark.
function registryExport(lines) {
  return (run) =>
    readWindowsValues(async (command, args, options) => {
      run?.(command, args, options);
      const text = [
        "Windows Registry Editor Version 5.00",
        "",
        "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\OpenWhispr]",
        ...lines,
        "",
      ].join("\r\n");
      fs.writeFileSync(args[2], `\uFEFF${text}`, "utf16le");
      return { stdout: "", stderr: "" };
    });
}

test("Windows reader exports the 64-bit machine key and keeps typed, Unicode values", async () => {
  let command;
  const policy = JSON.stringify(defaultDevicePolicy()).replaceAll('"', '\\"');
  const values = await registryExport([
    `"Policy"="${policy}"`,
    '"RequireSignIn"=dword:00000000',
    '"AuditLogPath"="C:\\\\企業\\\\監査.jsonl"',
    '"Unrelated"=hex(2):43,00,00,00',
  ])((...args) => {
    command = args;
  });
  assert.deepEqual(JSON.parse(values.Policy), defaultDevicePolicy());
  assert.equal(values.RequireSignIn, false);
  assert.equal(values.AuditLogPath, "C:\\企業\\監査.jsonl");
  assert.equal(
    command[0],
    path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe")
  );
  assert.deepEqual(
    command[1].filter((arg) => arg !== command[1][2]),
    ["export", "HKLM\\SOFTWARE\\Policies\\OpenWhispr", "/y", "/reg:64"]
  );
  assert.equal(command[2].windowsHide, true);
  assert.equal(fs.existsSync(command[1][2]), false);
  // Value names are case-insensitive, as in the registry itself.
  assert.deepEqual(await registryExport(['"requiresignin"=dword:00000001'])(), {
    RequireSignIn: true,
  });
  for (const line of [
    '"RequireSignIn"="0"',
    '"RequireSignIn"=dword:00000002',
    '"Policy"=dword:00000001',
    '"Policy"=hex(2):7b,00,00,00',
  ])
    await assert.rejects(registryExport([line])(), /Invalid registry value type/);
  assert.deepEqual(await readWindowsValues(registryWithoutPolicy()), {});
  // The key is there, but its export can't be written.
  await assert.rejects(
    readWindowsValues(async (_command, args) => {
      if (args[0] === "export")
        throw Object.assign(new Error("ERROR: Access is denied."), { code: 1 });
      return { stdout: "" };
    }),
    /Access is denied/
  );
  await assert.rejects(
    readWindowsValues(registryWithoutPolicy({ blocked: true })),
    /Registry editing/
  );
  await assert.rejects(
    readWindowsValues(async () => {
      throw Object.assign(new Error("timed out"), { killed: true, code: null });
    }),
    /timed out/
  );
});

test("evidence of a deployment is the policy key or file, not the reader's success", async () => {
  const existing = (files) => ({
    lstat: async (file) => {
      if (!files.includes(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {};
    },
  });
  assert.equal(
    await hasPolicyEvidence({
      platform: "linux",
      fileSystem: existing(["/etc/openwhispr/device.json"]),
    }),
    true
  );
  assert.equal(
    await hasPolicyEvidence({ platform: "linux", fileSystem: existing(["/etc/openwhispr"]) }),
    false
  );
  const plist = "/Library/Managed Preferences/com.gizmolabs.openwhispr.plist";
  assert.equal(
    await hasPolicyEvidence({ platform: "darwin", fileSystem: existing([plist]) }),
    true
  );
  assert.equal(await hasPolicyEvidence({ platform: "darwin", fileSystem: existing([]) }), false);
  let query;
  assert.equal(
    await hasPolicyEvidence({
      platform: "win32",
      run: async (command, args) => {
        query = args;
        return { stdout: "" };
      },
    }),
    true
  );
  assert.deepEqual(query, ["query", "HKLM\\SOFTWARE\\Policies\\OpenWhispr", "/reg:64"]);
  assert.equal(await hasPolicyEvidence({ platform: "win32", run: registryWithoutPolicy() }), false);
  await assert.rejects(
    hasPolicyEvidence({ platform: "win32", run: registryWithoutPolicy({ blocked: true }) }),
    /Registry editing/
  );
});

function linuxFileSystem(files, overrides = {}) {
  return {
    lstat: async () => ({
      uid: 0,
      mode: 0o755,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      ...overrides.directory,
    }),
    stat: async () => ({ uid: 0, mode: 0o755 }),
    open: async (filePath, flags) => {
      assert.ok(flags & require("node:fs").constants.O_NOFOLLOW);
      const value = files[filePath.split("/").at(-1)];
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const data = Buffer.from(JSON.stringify(value));
      return {
        stat: async () => ({
          uid: 0,
          mode: 0o644,
          size: data.length,
          isFile: () => true,
          ...overrides.file,
        }),
        read: async (buffer) => {
          data.copy(buffer);
          return { bytesRead: data.length };
        },
        close: async () => {},
      };
    },
  };
}

test("Linux reads raw policy and separate device metadata", async () => {
  const values = await readLinuxValues({
    fileSystem: linuxFileSystem({
      "policy.json": defaultDevicePolicy(),
      "device.json": { RequireSignIn: false },
    }),
  });
  assert.equal(JSON.parse(values.Policy).version, 1);
  assert.equal(values.RequireSignIn, false);
  for (const options of [
    { directory: { mode: 0o777 } },
    { directory: { uid: 501 } },
    { file: { mode: 0o666 } },
    { file: { uid: 501 } },
  ])
    await assert.rejects(
      readLinuxValues({
        fileSystem: linuxFileSystem({ "policy.json": defaultDevicePolicy() }, options),
      })
    );
  await assert.rejects(
    readLinuxValues({ fileSystem: linuxFileSystem({ "device.json": { Policy: "{}" } }) })
  );
});

function deviceReader({ evidence = false } = {}) {
  const warnings = [];
  const reader = {
    warnings,
    reads: 0,
    next: async () => ({}),
  };
  reader.manager = createManagedDevicePolicy({
    read: () => {
      reader.reads += 1;
      return reader.next();
    },
    hasPolicy: typeof evidence === "function" ? evidence : async () => evidence,
    logger: { warn: (message) => warnings.push(message) },
  });
  return reader;
}

const unreadable = async () => {
  throw new Error("unreadable");
};

test("a reader that fails with nothing deployed reads as absent, and says so", async () => {
  const reader = deviceReader();
  reader.next = unreadable;
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().status, "absent");
  assert.equal(reader.manager.getSnapshot().managed, false);
  assert.equal(reader.warnings.length, 1);
  reader.manager.stop();
});

test("a reader that can't tell whether a policy is deployed reads as absent, and says so", async () => {
  const reader = deviceReader({ evidence: unreadable });
  reader.next = unreadable;
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().status, "absent");
  assert.match(reader.warnings[0], /nor whether one is deployed/);
  reader.manager.stop();
});

test("a reader that fails with a deployment present is invalid until a read succeeds", async () => {
  const reader = deviceReader({ evidence: true });
  reader.next = unreadable;
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().code, "DEVICE_POLICY_INVALID");
  reader.next = async () => ({ RequireSignIn: false });
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().localOnly, true);
  reader.manager.stop();
});

test("a failed re-read keeps the policy last read in force", async () => {
  const reader = deviceReader();
  reader.next = async () => ({ RequireSignIn: false });
  await reader.manager.refresh();
  const { revision } = reader.manager.getSnapshot();
  reader.next = unreadable;
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().localOnly, true);
  assert.equal(reader.manager.getSnapshot().revision, revision);
  reader.manager.stop();
});

test("a deployment this build rejects replaces the policy last read", async () => {
  const reader = deviceReader();
  reader.next = async () => ({ RequireSignIn: false });
  await reader.manager.refresh();
  reader.next = async () => ({ RequireSignIn: 0 });
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().code, "DEVICE_POLICY_INVALID");
  reader.manager.stop();
});

test("reads already under way are joined, and focus re-reads are throttled", async () => {
  const reader = deviceReader();
  let finish;
  reader.next = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = reader.manager.refresh();
  const second = reader.manager.refresh();
  reader.manager.refreshOnFocus();
  finish({ RequireSignIn: false });
  await Promise.all([first, second]);
  assert.equal(reader.reads, 1);
  reader.manager.refreshOnFocus();
  assert.equal(reader.reads, 1);
  reader.manager.stop();
});

test("a read that completes after stop does not land", async () => {
  const reader = deviceReader();
  let finish;
  reader.next = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = reader.manager.refresh();
  reader.manager.stop();
  finish({ RequireSignIn: false });
  await pending;
  assert.equal(reader.manager.getSnapshot().status, "loading");
});
