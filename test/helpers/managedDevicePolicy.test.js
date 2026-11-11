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
  assert.equal(
    normalizeDeviceValues({ AuditLogPath: "", WipeLocalDataOnLaunch: false }).status,
    "absent"
  );
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

// What `reg query HKLM\SOFTWARE\Policies` prints: one line per subkey.
const policiesListing = (...subkeys) =>
  [
    "",
    ...["Microsoft", ...subkeys].map((key) => `HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\${key}`),
  ].join("\r\n");

// reg.exe without the OpenWhispr key or, `blocked`, unable to read any key.
function registryWithoutPolicy({ blocked = false } = {}) {
  return async () => {
    if (blocked)
      throw Object.assign(
        new Error("ERROR: Registry editing has been disabled by your administrator."),
        { code: 1 }
      );
    return { stdout: policiesListing() };
  };
}

// reg.exe writes a .reg export as UTF-16 with a byte order mark.
function registryExport(lines) {
  return (run) =>
    readWindowsValues(async (command, args, options) => {
      run?.(command, args, options);
      if (args[0] === "query") return { stdout: policiesListing("OpenWhispr") };
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
    '"Unrelated"=hex(2):43,00,00,00',
  ])((...args) => {
    command = args;
  });
  assert.deepEqual(JSON.parse(values.Policy), defaultDevicePolicy());
  assert.equal(values.RequireSignIn, false);
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
  // One reg.exe run when no key is deployed, which is every read on most machines.
  let runs = 0;
  const missing = registryWithoutPolicy();
  assert.deepEqual(
    await readWindowsValues((...args) => {
      runs += 1;
      return missing(...args);
    }),
    {}
  );
  assert.equal(runs, 1);
  // The key is there, but its export can't be written.
  await assert.rejects(
    readWindowsValues(async (_command, args) => {
      if (args[0] === "export")
        throw Object.assign(new Error("ERROR: Access is denied."), { code: 1 });
      return { stdout: policiesListing("openwhispr") };
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
        return { stdout: policiesListing("OpenWhispr") };
      },
    }),
    true
  );
  assert.deepEqual(query, ["query", "HKLM\\SOFTWARE\\Policies", "/reg:64"]);
  assert.equal(await hasPolicyEvidence({ platform: "win32", run: registryWithoutPolicy() }), false);
  await assert.rejects(
    hasPolicyEvidence({ platform: "win32", run: registryWithoutPolicy({ blocked: true }) }),
    /Registry editing/
  );
});

test("an inaccessible Linux deployment fails closed on its first read", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    const denied = async () => {
      throw Object.assign(new Error("permission denied"), { code });
    };
    const manager = createManagedDevicePolicy({
      platform: "linux",
      read: denied,
      hasPolicy: () => hasPolicyEvidence({ platform: "linux", fileSystem: { lstat: denied } }),
      logger: { warn() {} },
    });
    await manager.refresh();
    assert.equal(manager.getSnapshot().status, "invalid", code);
    assert.equal(manager.getSnapshot().managed, true, code);
    manager.stop();
  }
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
      const data = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
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
  for (const rejected of [
    async () => ({ RequireSignIn: 0 }),
    () => registryExport(['"RequireSignIn"="0"'])(),
    () => readLinuxValues({ fileSystem: linuxFileSystem({ "device.json": { Policy: "{}" } }) }),
  ]) {
    const reader = deviceReader();
    reader.next = async () => ({ RequireSignIn: false });
    await reader.manager.refresh();
    reader.next = rejected;
    await reader.manager.refresh();
    assert.equal(reader.manager.getSnapshot().code, "DEVICE_POLICY_INVALID");
    reader.manager.stop();
  }
});

test("a Linux policy file still being written keeps the policy last read", async () => {
  const reader = deviceReader();
  reader.next = async () => ({ RequireSignIn: false });
  await reader.manager.refresh();
  reader.next = () =>
    readLinuxValues({ fileSystem: linuxFileSystem({ "policy.json": '{"version":1,' }) });
  await reader.manager.refresh();
  assert.equal(reader.manager.getSnapshot().localOnly, true);
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
