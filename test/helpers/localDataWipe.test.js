const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CACHE_ENTRIES,
  KEPT_USER_DATA_ENTRIES,
  MODEL_CACHE_ENTRIES,
  MODEL_USER_DATA_ENTRIES,
  TEMP_PREFIXES,
  USER_DATA_ENTRIES,
  rememberNotesMirrorPath,
  removeLocalData,
  requestWorkspaceRemovalWipe,
  takeWipeNotice,
  wipeLocalDataOnLaunch,
} = require("../../src/helpers/localDataWipe");

// #3030: IT wipes a leaver's local OpenWhispr data through MDM. Reset app data
// and the WipeLocalDataOnLaunch device key remove the same inventory.

let root;
let roots;
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "local-data-wipe-"));
  roots = {
    userData: path.join(root, "userData"),
    caches: [path.join(root, "home-cache"), path.join(root, "cache-root")],
    temp: [path.join(root, "temp")],
    bridgeFile: path.join(root, "home", ".openwhispr", "cli-bridge.json"),
  };
});
test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seed(file, text = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Every store in the inventory, plus the audit log the wipe keeps.
function seedDevice() {
  for (const name of [...USER_DATA_ENTRIES, ...MODEL_USER_DATA_ENTRIES])
    seed(path.join(roots.userData, name, "item"));
  seed(path.join(roots.userData, "audit", "keep.txt"));
  for (const name of ["meeting-audit-session.json", "meeting-audit-session.json.tmp"])
    seed(path.join(roots.userData, name), "{}");
  for (const cache of roots.caches)
    for (const name of [...CACHE_ENTRIES, ...MODEL_CACHE_ENTRIES])
      seed(path.join(cache, name, "item"));
  seed(roots.bridgeFile);
  for (const prefix of TEMP_PREFIXES) seed(path.join(roots.temp[0], `${prefix}1.wav`));
  seed(path.join(roots.temp[0], "another-app.tmp"));
}

const exists = (...parts) => fs.existsSync(path.join(...parts));

test("removes every store and keeps the audit log, the wipe record and, by default, models", async () => {
  seedDevice();
  seed(path.join(roots.userData, "local-data-wipe.json"), "{}");
  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);

  for (const name of USER_DATA_ENTRIES) assert.equal(exists(roots.userData, name), false, name);
  for (const name of [...KEPT_USER_DATA_ENTRIES, ...MODEL_USER_DATA_ENTRIES])
    assert.equal(exists(roots.userData, name), true, name);
  for (const cache of roots.caches) {
    for (const name of CACHE_ENTRIES) assert.equal(exists(cache, name), false, name);
    for (const name of MODEL_CACHE_ENTRIES) assert.equal(exists(cache, name), true, name);
  }
  assert.equal(fs.existsSync(roots.bridgeFile), false);
  assert.deepEqual(fs.readdirSync(roots.temp[0]), ["another-app.tmp"]);

  assert.deepEqual(await removeLocalData({ includeModels: true, roots }), []);
  for (const name of MODEL_USER_DATA_ENTRIES) assert.equal(exists(roots.userData, name), false);
  for (const cache of roots.caches)
    for (const name of MODEL_CACHE_ENTRIES) assert.equal(exists(cache, name), false, name);
});

test("in a notes folder the user chose, only the mirror's own files and the folders it emptied go", async () => {
  const chosen = path.join(root, "Vault");
  const personal = path.join(chosen, "Personal");
  seed(path.join(personal, "12-standup.md"), "---\nid: 12\ntitle: Standup\n---\n\nbody");
  seed(path.join(personal, "12-standup-transcript.md"), "# Standup\n");
  seed(path.join(chosen, "Work", "7-plan.md"), "\uFEFF---\r\nid: 7\r\n---\r\n");
  // The user's own files: a daily note named like a mirror file, a note whose
  // frontmatter names another id, a transcript with no mirrored note, and a
  // folder they left empty.
  seed(path.join(personal, "2024-03-05.md"), "---\ntitle: Daily\n---\n");
  seed(path.join(personal, "3-copied.md"), "---\nid: 4\n---\n");
  seed(path.join(personal, "9-call-transcript.md"), "# Call\n");
  seed(path.join(chosen, "readme.md"), "mine");
  fs.mkdirSync(path.join(chosen, "Ideas"));
  // A folder the mirror wrote to before it moved to the one above.
  const earlier = path.join(root, "Old notes");
  fs.mkdirSync(roots.userData, { recursive: true });
  seed(path.join(earlier, "Personal", "5-retro.md"), "---\nid: 5\n---\n");
  rememberNotesMirrorPath(earlier, roots.userData);
  rememberNotesMirrorPath(chosen, roots.userData);
  rememberNotesMirrorPath(chosen, roots.userData);

  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
  assert.deepEqual(fs.readdirSync(chosen).sort(), ["Ideas", "Personal", "readme.md"]);
  assert.deepEqual(fs.readdirSync(personal).sort(), [
    "2024-03-05.md",
    "3-copied.md",
    "9-call-transcript.md",
  ]);
  assert.deepEqual(fs.readdirSync(earlier), []);
  assert.equal(exists(roots.userData, "notes-mirror.json"), false);
});

function launchHarness({ snapshot, readError, clearBrowserData = async () => {}, env = {} } = {}) {
  const calls = [];
  const options = {
    env,
    userDataPath: roots.userData,
    appVersion: "1.12.0",
    roots,
    clearBrowserData: async () => {
      calls.push("browser data");
      await clearBrowserData();
    },
    readDevicePolicy: async () => {
      if (readError) throw readError;
      return snapshot;
    },
    deleteMasterKey: () => calls.push("master key"),
    disableAutoStart: () => calls.push("launch at login"),
    logger: {
      warn: () => {},
      error: () => {},
      close: () => calls.push("logger closed"),
    },
  };
  return { calls, wipe: () => wipeLocalDataOnLaunch(options) };
}

const managed = (token, extra = {}) => ({
  status: "valid",
  managed: true,
  wipeLocalDataOnLaunch: token,
  wipeLocalDataIncludesModels: false,
  auditLogPath: null,
  ...extra,
});
const auditLines = () => {
  const dir = path.join(roots.userData, "audit");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line));
};

test("a new token wipes once, records itself and the audit line, then asks for a relaunch", async () => {
  seedDevice();
  const first = launchHarness({ snapshot: managed("offboard-1") });
  assert.equal(await first.wipe(), true);
  assert.deepEqual(first.calls, ["logger closed", "browser data", "launch at login", "master key"]);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.equal(exists(roots.userData, "installed-models.json"), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(roots.userData, "local-data-wipe.json"), "utf8")),
    { token: "offboard-1" }
  );
  const [wiped] = auditLines();
  assert.equal(wiped.event, "local-data.wiped");
  assert.equal(wiped.reason, null);

  // The same token again: the fresh install it left is not wiped twice.
  seed(path.join(roots.userData, "transcriptions.db"));
  const again = launchHarness({ snapshot: managed("offboard-1") });
  assert.equal(await again.wipe(), false);
  assert.deepEqual(again.calls, []);
  assert.equal(exists(roots.userData, "transcriptions.db"), true);

  // A new token is a new request.
  const next = launchHarness({
    snapshot: managed("offboard-2", { wipeLocalDataIncludesModels: true }),
  });
  assert.equal(await next.wipe(), true);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.equal(exists(roots.userData, "installed-models.json"), false);
  assert.equal(auditLines().length, 2);
});

// main.js loads .env into process.env, and the relaunch inherits it.
test("settings main loaded from .env don't follow the relaunch into the fresh install", async () => {
  seedDevice();
  fs.rmSync(path.join(roots.userData, ".env"), { recursive: true });
  seed(path.join(roots.userData, ".env"), "DICTATION_KEY=F8\nUI_LANGUAGE=fr\n");
  // UI_LANGUAGE came from the shell: dotenv never overrides what is already set.
  const env = { DICTATION_KEY: "F8", UI_LANGUAGE: "de", PATH: "/usr/bin" };
  assert.equal(await launchHarness({ snapshot: managed("offboard-1"), env }).wipe(), true);
  assert.deepEqual(env, { UI_LANGUAGE: "de", PATH: "/usr/bin" });
});

// #3030's second trigger: a running app that hears its account was removed
// from the managing workspace records it and quits; the next launch wipes.
test("a recorded workspace removal wipes at the next launch, once, and leaves a notice", async () => {
  seedDevice();
  seed(path.join(roots.userData, "local-data-wipe.json"), JSON.stringify({ token: "offboard-1" }));
  const removal = {
    accountId: "account-a",
    workspaceId: "ws-1",
    removedAt: "2026-11-12T10:00:00Z",
  };
  assert.equal(requestWorkspaceRemovalWipe(roots.userData, removal), true);

  // The server said so: no device policy needs to be readable.
  const unreadable = () =>
    launchHarness({ readError: new Error("Managed policy reader unavailable") });
  const first = unreadable();
  assert.equal(await first.wipe(), true);
  assert.ok(first.calls.includes("master key"));
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.equal(exists(roots.userData, "installed-models.json"), true);
  assert.equal(auditLines()[0].trigger, "workspace-removal");

  assert.equal(await unreadable().wipe(), false);
  // The token acted on before stays on record, so it doesn't wipe again either.
  assert.equal(await launchHarness({ snapshot: managed("offboard-1") }).wipe(), false);
  assert.equal(takeWipeNotice(roots.userData), "workspace-removal");
  assert.equal(takeWipeNotice(roots.userData), null);
});

test("an MDM token wipe leaves no removal notice", async () => {
  seedDevice();
  assert.equal(await launchHarness({ snapshot: managed("offboard-1") }).wipe(), true);
  assert.equal(auditLines()[0].trigger, "device-policy");
  assert.equal(takeWipeNotice(roots.userData), null);
});

test("only a production build deletes the keyring master key every channel shares", async () => {
  seedDevice();
  const staging = launchHarness({
    snapshot: managed("offboard-1"),
    env: { OPENWHISPR_CHANNEL: "staging" },
  });
  assert.equal(await staging.wipe(), true);
  assert.equal(staging.calls.includes("master key"), false);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
});

test("an unreadable or rejected policy, or one without a token, never wipes", async () => {
  for (const harness of [
    launchHarness({ readError: new Error("Managed policy reader unavailable") }),
    launchHarness({
      readError: Object.assign(new Error("bad"), { code: "DEVICE_POLICY_INVALID" }),
    }),
    launchHarness({ snapshot: { status: "invalid", managed: true, policy: null } }),
    launchHarness({ snapshot: { status: "absent", managed: false, policy: null } }),
    launchHarness({ snapshot: managed(null) }),
  ]) {
    seedDevice();
    assert.equal(await harness.wipe(), false);
    assert.deepEqual(harness.calls, []);
    assert.equal(exists(roots.userData, "transcriptions.db"), true);
  }
});

test("a wipe that leaves a store behind still records its token, marked incomplete", async () => {
  seedDevice();
  const harness = launchHarness({
    snapshot: managed("offboard-1"),
    clearBrowserData: async () => {
      throw new Error("session unavailable");
    },
  });
  assert.equal(await harness.wipe(), true);
  assert.equal(auditLines()[0].reason, "incomplete");
  assert.equal(exists(roots.userData, "local-data-wipe.json"), true);
});

test("without its token on record the app carries on instead of relaunching into another wipe", async () => {
  seedDevice();
  // A folder where the record goes: the write fails, as on a read-only disk.
  fs.mkdirSync(path.join(roots.userData, "local-data-wipe.json"));
  const harness = launchHarness({ snapshot: managed("offboard-1") });
  assert.equal(await harness.wipe(), false);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
});

// The inventory owns every path: a new store under userData, the model cache
// root, ~/.cache/openwhispr or a temp folder fails here until it is listed.
// A path built in two steps (a folder in a variable, then a name) is out of its
// reach, so such a store is added to the inventory by hand.
test("every data path the app writes is in the inventory or kept on purpose", () => {
  const repo = path.join(__dirname, "../..");
  const sources = [path.join(repo, "main.js")];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts|tsx)$/.test(entry.name)) sources.push(full);
    }
  };
  walk(path.join(repo, "src"));
  const texts = sources.map((file) => [path.relative(repo, file), fs.readFileSync(file, "utf8")]);

  // Constants another file imports, by name.
  const constants = new Map();
  for (const [, text] of texts)
    for (const [, name, value] of text.matchAll(/const ([A-Z][A-Z0-9_]*) =\s*([^;]+);/g))
      constants.set(name, value);
  // The names a path argument stands for: a literal, both branches of a
  // ternary, or a constant (this file's, else an imported one) holding either.
  const names = (expression, text) => {
    const branches = [...expression.matchAll(/[?:]\s*"([^"]+)"/g)].map((match) => match[1]);
    if (branches.length > 0) return branches;
    const literal = /^\s*"([^"]+)"\s*$/.exec(expression)?.[1];
    if (literal) return [literal];
    const id = /^\s*([A-Za-z_]\w*)\s*$/.exec(expression)?.[1];
    const value =
      id && (new RegExp(`const ${id} =\\s*([^;]+);`).exec(text)?.[1] ?? constants.get(id));
    return value ? names(value, text) : [];
  };

  const userData = new Set([
    ...USER_DATA_ENTRIES,
    ...MODEL_USER_DATA_ENTRIES,
    ...KEPT_USER_DATA_ENTRIES,
  ]);
  const caches = new Set([...CACHE_ENTRIES, ...MODEL_CACHE_ENTRIES]);
  const missing = [];
  for (const [where, text] of texts) {
    const check = (pattern, known, kind) => {
      for (const match of text.matchAll(pattern))
        for (const name of names(match[1], text))
          if (!known(name)) missing.push(`${where}: ${kind} ${name}`);
    };
    check(
      /(?:getPath\("userData"\)|userDataDir|userDataPath|bootstrapDirectory),\s*([^,)]+)/g,
      (name) => userData.has(name),
      "userData"
    );
    check(
      /(?:getCacheRoot\(\)|"\.cache",\s*"openwhispr"),\s*([^,)]+)/g,
      (name) => caches.has(name),
      "cache"
    );
    check(/getModelsDirForService\(("[^"]+")\)/g, (name) => caches.has(`${name}-models`), "models");
    for (const match of text.matchAll(/(?:tmpdir\(\)|getSafeTempDir\(\)),\s*[`"]([^`"$]+)/g))
      if (!TEMP_PREFIXES.some((prefix) => match[1].startsWith(prefix)))
        missing.push(`${where}: temp ${match[1]}`);
  }
  assert.deepEqual(missing, []);
});

// startApp() can't run in a unit test, so this pins where the wipe sits in it:
// after stale sidecars are gone, before anything opens a file it removes, and
// restarting through the relaunch Reset app data uses.
test("the launch wipe runs before the logger, catalog and core managers, then relaunches", () => {
  const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const startApp = main.slice(main.indexOf("async function startApp()"));
  const at = (code) => {
    const index = startApp.indexOf(code);
    assert.ok(index >= 0, `startApp() contains ${code}`);
    return index;
  };
  const wipe = at("await wipeLocalDataOnLaunch(");
  assert.ok(at("await reapStaleSidecars();") < wipe);
  for (const later of [
    "debugLogger.ensureFileLogging();",
    "await registryLoader.start();",
    "initializeCoreManagers();",
  ])
    assert.ok(wipe < at(later), `the wipe runs before ${later}`);
  assert.ok(wipe < at("autoStart.scheduleRelaunch(OAUTH_PROTOCOL)"));
});

// The scripts run without the app, so they carry their own copy of the lists.
test("the MDM scripts keep and treat as models exactly what the app does", () => {
  const scripts = path.join(__dirname, "../../scripts/mdm");
  const bash = fs.readFileSync(path.join(scripts, "wipe-local-data-macos.sh"), "utf8");
  const powershell = fs.readFileSync(path.join(scripts, "wipe-local-data-windows.ps1"), "utf8");
  const bashList = (name) => new RegExp(`^${name}=\\(([^)]*)\\)`, "m").exec(bash)[1].split(/\s+/);
  const powershellList = (name) =>
    [
      ...new RegExp(`^\\$${name} = @\\(([^)]*)\\)`, "m").exec(powershell)[1].matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);
  for (const [bashName, powershellName, expected] of [
    ["kept_user_data", "keptUserData", KEPT_USER_DATA_ENTRIES],
    ["model_user_data", "modelUserData", MODEL_USER_DATA_ENTRIES],
    ["model_cache", "modelCache", MODEL_CACHE_ENTRIES],
    ["temp_prefixes", "tempPrefixes", TEMP_PREFIXES],
  ]) {
    assert.deepEqual(bashList(bashName), expected, bashName);
    assert.deepEqual(powershellList(powershellName), expected, powershellName);
  }
});

test(
  "the macOS script empties a home's OpenWhispr data and keeps what the app keeps",
  { skip: process.platform === "win32" },
  async () => {
    const { execFileSync } = require("node:child_process");
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "OpenWhispr");
    const cache = path.join(home, ".cache", "openwhispr");
    for (const name of [
      ...USER_DATA_ENTRIES,
      ...MODEL_USER_DATA_ENTRIES,
      ...KEPT_USER_DATA_ENTRIES,
    ])
      seed(path.join(userData, name, "item"));
    seed(path.join(userData, "Local Storage", "leveldb", "000003.log"));
    for (const name of [...CACHE_ENTRIES, ...MODEL_CACHE_ENTRIES])
      seed(path.join(cache, name, "item"));
    seed(path.join(home, ".openwhispr", "cli-bridge.json"));
    seed(path.join(home, ".openwhispr", "cli-config.json"));
    const vault = path.join(home, "Documents", "Vault");
    seed(path.join(vault, "Personal", "12-standup.md"), "---\nid: 12\n---\n");
    seed(path.join(vault, "Personal", "12-standup-transcript.md"), "# Standup\n");
    seed(path.join(vault, "Personal", "2024-03-05.md"), "---\ntitle: Daily\n---\n");
    // Run as root, the script never follows a record out of the user's home.
    const outside = path.join(root, "Shared");
    seed(path.join(outside, "Team", "3-plan.md"), "---\nid: 3\n---\n");
    fs.rmSync(path.join(userData, "notes-mirror.json"), { recursive: true });
    seed(path.join(userData, "notes-mirror.json"), JSON.stringify({ basePaths: [vault, outside] }));
    // Never the real app: process lookups see nothing running.
    const bin = path.join(root, "bin");
    for (const tool of ["pgrep", "pkill"]) seed(path.join(bin, tool), "#!/bin/sh\nexit 1\n");
    for (const tool of ["pgrep", "pkill"]) fs.chmodSync(path.join(bin, tool), 0o755);
    const run = (...args) =>
      execFileSync(
        "/bin/bash",
        [path.join(__dirname, "../../scripts/mdm/wipe-local-data-macos.sh"), ...args],
        {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          encoding: "utf8",
        }
      );

    run(home);
    assert.deepEqual(
      fs.readdirSync(userData).sort(),
      [...KEPT_USER_DATA_ENTRIES, ...MODEL_USER_DATA_ENTRIES].sort()
    );
    assert.deepEqual(fs.readdirSync(cache).sort(), [...MODEL_CACHE_ENTRIES].sort());
    assert.deepEqual(fs.readdirSync(path.join(home, ".openwhispr")), ["cli-config.json"]);
    // The record is read with plutil, which only macOS has.
    if (process.platform === "darwin")
      assert.deepEqual(fs.readdirSync(path.join(vault, "Personal")), ["2024-03-05.md"]);
    assert.deepEqual(fs.readdirSync(path.join(outside, "Team")), ["3-plan.md"]);

    // A folder the user replaced with a symlink is not followed out of the home.
    const linked = path.join(root, "linked-home");
    const elsewhere = path.join(root, "elsewhere");
    seed(path.join(linked, "Library", "Application Support", "OpenWhispr", "audio", "1.webm"));
    seed(path.join(elsewhere, "openwhispr", "qdrant-data", "item"));
    fs.symlinkSync(elsewhere, path.join(linked, ".cache"));
    run(linked);
    assert.equal(fs.existsSync(path.join(elsewhere, "openwhispr", "qdrant-data", "item")), true);
    assert.deepEqual(
      fs.readdirSync(path.join(linked, "Library", "Application Support", "OpenWhispr")),
      []
    );

    // A folder it can't empty is reported, the rest still goes, and the exit
    // code tells the MDM tool the device failed. (Root ignores the mode.)
    if (process.getuid() !== 0) {
      const stuck = path.join(root, "stuck-home");
      const stuckData = path.join(stuck, "Library", "Application Support", "OpenWhispr");
      seed(path.join(stuckData, "audio", "1.webm"));
      seed(path.join(stuckData, "logs", "debug.log"));
      fs.chmodSync(path.join(stuckData, "audio"), 0o555);
      try {
        assert.throws(
          () => run(stuck),
          (error) => error.status === 1
        );
        assert.deepEqual(fs.readdirSync(stuckData), ["audio"]);
      } finally {
        fs.chmodSync(path.join(stuckData, "audio"), 0o755);
      }
    }

    run("--include-models", home);
    assert.deepEqual(fs.readdirSync(userData).sort(), [...KEPT_USER_DATA_ENTRIES].sort());
    assert.deepEqual(fs.readdirSync(cache), []);
  }
);
