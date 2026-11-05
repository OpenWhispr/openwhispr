const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../../src/models/modelRegistryData.json");
const {
  createManagedDevicePolicy,
  defaultDevicePolicy,
  normalizeDeviceValues,
  readLinuxValues,
  readWindowsValues,
} = require("../../src/helpers/managedDevicePolicy");

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

test("malformed documents, partial policies, unsupported controls and wrong device types fail", () => {
  for (const values of [
    { Policy: "{" },
    { Policy: { version: 1 } },
    { Policy: JSON.stringify({ features: { meetingRecordingEnabled: false } }) },
    { Policy: JSON.stringify({ ...defaultDevicePolicy(), apiAccessEnabled: false }) },
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

test("Windows reader accepts typed machine-policy values and preserves Unicode", async () => {
  let command;
  const values = await readWindowsValues(async (...args) => {
    command = args;
    return {
      stdout: JSON.stringify({
        Policy: { kind: "String", value: JSON.stringify(defaultDevicePolicy()) },
        RequireSignIn: { kind: "DWord", value: 0 },
        AuditLogPath: { kind: "String", value: "C:\\企業\\監査.jsonl" },
      }),
    };
  });
  assert.equal(values.RequireSignIn, false);
  assert.equal(values.AuditLogPath, "C:\\企業\\監査.jsonl");
  assert.equal(command[0], "powershell.exe");
  const script = Buffer.from(command[1].at(-1), "base64").toString("utf16le");
  assert.match(script, /RegistryHive\]::LocalMachine/);
  assert.match(script, /RegistryView\]::Registry64/);
  assert.equal(command[2].windowsHide, true);
  await assert.rejects(
    readWindowsValues(async () => ({
      stdout: JSON.stringify({ RequireSignIn: { kind: "String", value: "0" } }),
    }))
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

test("reader errors fail closed, recover, and ignore an older read completion", async () => {
  let complete;
  let read = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const manager = createManagedDevicePolicy({ read: () => read() });
  const older = manager.refresh();
  read = async () => {
    throw new Error("unreadable");
  };
  await manager.refresh();
  assert.equal(manager.getSnapshot().status, "invalid");
  complete({});
  await older;
  assert.equal(manager.getSnapshot().status, "invalid");
  read = async () => ({ RequireSignIn: false });
  await manager.refresh();
  assert.equal(manager.getSnapshot().localOnly, true);
  manager.stop();
});
