const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The dictation commit cannot use saveDictationKey: _saveKey writes only
// process.env and returns a hardcoded success, and the one durable write is
// fire-and-forget behind .catch(() => {}). saveStagedKeys is the path that
// actually reports failure, and that keeps a tentative value out of
// process.env until the rename has succeeded.

const WATCHED = ["DICTATION_KEY", "DICTATION_HOTKEY_CONFIG", "START_MINIMIZED"];

function snapshotEnvironment() {
  return new Map(
    WATCHED.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
}

function restoreEnvironment(snapshot) {
  for (const [name, { present, value }] of snapshot) {
    if (present) process.env[name] = value;
    else delete process.env[name];
  }
}

function loadEnvironmentManager(t, userDataDirectory) {
  const environmentPath = require.resolve("../../src/helpers/environment");
  const originalEnvironmentModule = require.cache[environmentPath];
  const originalLoad = Module._load;
  delete require.cache[environmentPath];

  Module._load = function loadWithTestDependencies(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDirectory,
          getAppPath: () => userDataDirectory,
          isReady: () => false,
        },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "./secretCrypto") return { isAvailable: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(environmentPath);
  } finally {
    Module._load = originalLoad;
    t.after(() => {
      if (originalEnvironmentModule) require.cache[environmentPath] = originalEnvironmentModule;
      else delete require.cache[environmentPath];
    });
  }
}

// config() is stubbed so a write does not reload the file into process.env
// mid-test, but parse() is kept REAL: the point of these tests is what the
// genuine dotenv does with the value we wrote.
const realDotenvParse = require("dotenv").parse;

function installDotenvStub(t) {
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }), parse: realDotenvParse },
  };
  t.after(() => {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
  });
}

function setup(t) {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-staged-env-"));
  const environmentSnapshot = snapshotEnvironment();
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of WATCHED) delete process.env[name];

  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  return {
    manager: new EnvironmentManager(),
    envPath: path.join(userDataDirectory, ".env"),
    userDataDirectory,
  };
}

const CONFIG = JSON.stringify([
  { key: "Ctrl+Shift+Space", mode: "cleaned" },
  { key: "Control+Alt+Shift", mode: "raw" },
]);

test("a staged write lands both values in one file and then publishes them", async (t) => {
  const { manager, envPath } = setup(t);

  const result = await manager.saveStagedKeys({
    DICTATION_KEY: "Ctrl+Shift+Space,Control+Alt+Shift",
    DICTATION_HOTKEY_CONFIG: CONFIG,
  });

  assert.equal(result.success, true);
  const written = fs.readFileSync(envPath, "utf8");
  assert.match(written, /^DICTATION_KEY=Ctrl\+Shift\+Space,Control\+Alt\+Shift$/m);
  assert.ok(written.includes(`DICTATION_HOTKEY_CONFIG=${CONFIG}`));
  // Published only after the rename succeeded.
  assert.equal(process.env.DICTATION_KEY, "Ctrl+Shift+Space,Control+Alt+Shift");
  assert.equal(process.env.DICTATION_HOTKEY_CONFIG, CONFIG);
});

// The whole point of staging: a commit that fails to reach disk must leave no
// trace a later unrelated save could pick up and persist.
test("a failed staged write leaves process.env untouched", async (t) => {
  const { manager } = setup(t);
  process.env.DICTATION_KEY = "F8";

  const originalRename = fs.promises.rename;
  fs.promises.rename = async () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  t.after(() => {
    fs.promises.rename = originalRename;
  });

  await assert.rejects(
    manager.saveStagedKeys({ DICTATION_KEY: "F9", DICTATION_HOTKEY_CONFIG: CONFIG }),
    /EACCES/
  );

  assert.equal(process.env.DICTATION_KEY, "F8", "the old value must survive a failed commit");
  assert.equal(process.env.DICTATION_HOTKEY_CONFIG, undefined);
});

test("an empty staged value clears the key rather than writing a blank line", async (t) => {
  const { manager, envPath } = setup(t);
  await manager.saveStagedKeys({ DICTATION_HOTKEY_CONFIG: CONFIG });
  assert.equal(process.env.DICTATION_HOTKEY_CONFIG, CONFIG);

  await manager.saveStagedKeys({ DICTATION_HOTKEY_CONFIG: "" });

  assert.equal(process.env.DICTATION_HOTKEY_CONFIG, undefined);
  assert.doesNotMatch(fs.readFileSync(envPath, "utf8"), /^DICTATION_HOTKEY_CONFIG=/m);
});

test("staged writes do not disturb unrelated persisted keys", async (t) => {
  const { manager, envPath } = setup(t);
  process.env.START_MINIMIZED = "true";

  await manager.saveStagedKeys({ DICTATION_HOTKEY_CONFIG: CONFIG });

  assert.match(fs.readFileSync(envPath, "utf8"), /^START_MINIMIZED=true$/m);
});

test("overlapping staged writes serialize rather than racing the same tmp file", async (t) => {
  const { manager, envPath } = setup(t);

  await Promise.all([
    manager.saveStagedKeys({ DICTATION_KEY: "F8" }),
    manager.saveStagedKeys({ DICTATION_KEY: "F9" }),
    manager.saveStagedKeys({ DICTATION_KEY: "F10" }),
  ]);

  // Last write wins, and the file is readable rather than half-renamed.
  assert.equal(process.env.DICTATION_KEY, "F10");
  assert.match(fs.readFileSync(envPath, "utf8"), /^DICTATION_KEY=F10$/m);
});

test("the dictation hotkey config reads back through its accessor", async (t) => {
  const { manager } = setup(t);
  assert.equal(manager.getDictationHotkeyConfig(), "");
  const EnvironmentManager = manager.constructor;

  await manager.saveStagedKeys({
    DICTATION_HOTKEY_CONFIG: EnvironmentManager.encodeDictationHotkeyConfig(CONFIG),
  });

  assert.equal(manager.getDictationHotkeyConfig(), CONFIG);
});

// dotenv truncates an unquoted value at "#", and dotenv 17 does not unescape
// \" inside a double-quoted one, so a hotkey as ordinary as Control+# would
// silently lose every row after it. The round trip that matters is through the
// real writer and the real dotenv, not JSON alone.
test("hotkeys containing dotenv metacharacters survive writer -> dotenv -> parse", async (t) => {
  const { manager, envPath } = setup(t);
  const EnvironmentManager = manager.constructor;
  const dotenv = require("dotenv");
  const { parseConfig } = await import("../../src/helpers/dictationHotkeyConfig.js");
  const { canonicalizeHotkey } = require("../../src/helpers/hotkeyCanonical.js");
  const canon = (key) => canonicalizeHotkey(key, "win32");

  const hostile = JSON.stringify([
    { key: "Control+#", mode: "raw" },
    { key: "Control+'", mode: "cleaned" },
    { key: 'Control+"', mode: "raw" },
    { key: "Control+,", mode: null },
    { key: "Control+Shift+Space", mode: "cleaned" },
  ]);

  await manager.saveStagedKeys({
    DICTATION_HOTKEY_CONFIG: EnvironmentManager.encodeDictationHotkeyConfig(hostile),
  });

  // Read the file the way the app does at launch, through dotenv itself.
  const fromDisk = dotenv.parse(fs.readFileSync(envPath, "utf8")).DICTATION_HOTKEY_CONFIG;
  assert.ok(fromDisk, "the value must survive dotenv at all");
  process.env.DICTATION_HOTKEY_CONFIG = fromDisk;

  const rows = parseConfig(manager.getDictationHotkeyConfig(), canon);
  assert.deepEqual(rows, [
    { key: "Control+#", mode: "raw" },
    { key: "Control+'", mode: "cleaned" },
    { key: 'Control+"', mode: "raw" },
    { key: "Control+,", mode: null },
    { key: "Control+Shift+Space", mode: "cleaned" },
  ]);
});

// A1/A3: the publish must happen inside the queued task. If it happened after
// merely awaiting the write, an unrelated save could serialize the file from
// the still-old process.env and undo the commit.
test("an unrelated save interleaved with a staged commit cannot clobber it", async (t) => {
  const { manager, envPath } = setup(t);
  const EnvironmentManager = manager.constructor;
  const encoded = EnvironmentManager.encodeDictationHotkeyConfig(CONFIG);

  // Both enqueue in the same tick, worst case for the race.
  const staged = manager.saveStagedKeys({
    DICTATION_KEY: "Ctrl+Shift+Space",
    DICTATION_HOTKEY_CONFIG: encoded,
  });
  const unrelated = manager.saveAllKeysToEnvFile();
  await Promise.all([staged, unrelated]);

  const onDisk = fs.readFileSync(envPath, "utf8");
  assert.match(onDisk, /^DICTATION_KEY=Ctrl\+Shift\+Space$/m, "disk kept the committed key");
  assert.ok(
    onDisk.includes(`DICTATION_HOTKEY_CONFIG=${encoded}`),
    "disk kept the committed config"
  );
  // Disk and process.env agree — the whole point of publishing inside the task.
  assert.equal(process.env.DICTATION_KEY, "Ctrl+Shift+Space");
  assert.equal(process.env.DICTATION_HOTKEY_CONFIG, encoded);
  assert.equal(manager.getDictationHotkeyConfig(), CONFIG);
});

test("a staged commit racing an unrelated save in the opposite order also stays coherent", async (t) => {
  const { manager, envPath } = setup(t);
  const EnvironmentManager = manager.constructor;
  process.env.START_MINIMIZED = "true";
  const encoded = EnvironmentManager.encodeDictationHotkeyConfig(CONFIG);

  const unrelated = manager.saveAllKeysToEnvFile();
  const staged = manager.saveStagedKeys({ DICTATION_HOTKEY_CONFIG: encoded });
  await Promise.all([unrelated, staged]);

  const onDisk = fs.readFileSync(envPath, "utf8");
  assert.ok(onDisk.includes(`DICTATION_HOTKEY_CONFIG=${encoded}`));
  assert.match(onDisk, /^START_MINIMIZED=true$/m, "the unrelated key is not lost either");
  assert.equal(process.env.DICTATION_HOTKEY_CONFIG, encoded);
});
