const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CACHE_ENTRIES,
  KEPT_USER_DATA_ENTRIES,
  MODEL_CACHE_ENTRIES,
  MODEL_CACHE_ROOT_ENTRIES,
  MODEL_USER_DATA_ENTRIES,
  TEMP_PREFIXES,
  USER_DATA_ENTRIES,
  removeLocalData,
  requestWorkspaceRemovalWipe,
  takeWipeNotice,
  wipeLocalDataOnLaunch,
} = require("../../src/helpers/localDataWipe");

// #3030: IT wipes a leaver's local OpenWhispr data through MDM or by removing
// them from the managing workspace; both triggers remove the same inventory.

let root;
let roots;
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "local-data-wipe-"));
  roots = {
    userData: path.join(root, "userData"),
    homeCache: path.join(root, "home-cache"),
    cacheRoot: path.join(root, "cache-root"),
    temp: [path.join(root, "temp")],
    bridgeFile: path.join(root, "home", ".openwhispr", "cli-bridge.json"),
    // XDG_CACHE_HOME's folder, outside the home cache.
    portalTokenFile: path.join(root, "xdg-cache", "openwhispr", "portal-paste-token"),
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
  for (const name of [
    "meeting-audit-session.json",
    "meeting-audit-session.json.tmp",
    "globe-preference-state.json",
  ])
    seed(path.join(roots.userData, name), "{}");
  // The model cache root may be a folder other apps share, holding names
  // OpenWhispr's own cache folder uses too.
  for (const cache of [roots.homeCache, roots.cacheRoot])
    for (const name of [...CACHE_ENTRIES, ...MODEL_CACHE_ENTRIES])
      seed(path.join(cache, name, "item"));
  seed(roots.bridgeFile);
  seed(roots.portalTokenFile);
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
  for (const name of CACHE_ENTRIES) assert.equal(exists(roots.homeCache, name), false, name);
  for (const name of MODEL_CACHE_ENTRIES) assert.equal(exists(roots.homeCache, name), true, name);
  for (const name of [...CACHE_ENTRIES, ...MODEL_CACHE_ENTRIES])
    assert.equal(exists(roots.cacheRoot, name), true, name);
  assert.equal(fs.existsSync(roots.bridgeFile), false);
  assert.equal(fs.existsSync(roots.portalTokenFile), false);
  assert.deepEqual(fs.readdirSync(roots.temp[0]), ["another-app.tmp"]);

  assert.deepEqual(await removeLocalData({ includeModels: true, roots }), []);
  for (const name of MODEL_USER_DATA_ENTRIES) assert.equal(exists(roots.userData, name), false);
  for (const name of MODEL_CACHE_ENTRIES) assert.equal(exists(roots.homeCache, name), false, name);
  // In the model cache root, only the models OpenWhispr keeps there.
  assert.deepEqual(
    fs.readdirSync(roots.cacheRoot).sort(),
    [
      ...CACHE_ENTRIES,
      ...MODEL_CACHE_ENTRIES.filter((name) => !MODEL_CACHE_ROOT_ENTRIES.includes(name)),
    ].sort()
  );
});

// What the mirror writes: its note frontmatter, and a transcript's opening.
const mirrored = (id, extra = "") =>
  `---\nid: ${id}\ntitle: "Note ${id}"\ntype: personal\n${extra}created: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-02T00:00:00.000Z\n---\n\nbody`;
const transcriptOf = (title) => `# ${title}\n\n**2026-11-11 09:00**\n\nSpeaker 1: hello\n`;

// A file the mirror wrote: on disk, and in its record in the database, as
// database.js keeps it (the folder's key is its realpath, as the mirror's).
function mirrorWrote(userData, base, relPath, text, kind = "note") {
  if (kind === "dir") fs.mkdirSync(path.join(base, ...relPath.split("/")), { recursive: true });
  else seed(path.join(base, ...relPath.split("/")), text);
  fs.mkdirSync(userData, { recursive: true });
  const db = new (require("better-sqlite3"))(path.join(userData, "transcriptions.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS note_mirror_files (
      base_path TEXT NOT NULL, rel_path TEXT NOT NULL, owner_id INTEGER, kind TEXT NOT NULL,
      content_hash TEXT, PRIMARY KEY (base_path, rel_path))`);
    db.prepare("INSERT INTO note_mirror_files VALUES (?, ?, 1, ?, ?)").run(
      fs.realpathSync(base),
      relPath,
      kind,
      require("node:crypto").createHash("sha256").update(text, "utf8").digest("hex")
    );
  } finally {
    db.close();
  }
}

test("in a notes folder the user chose, only the files the mirror recorded and the folders that emptied go", async () => {
  const chosen = path.join(root, "Vault");
  const wrote = (relPath, text, kind) => mirrorWrote(roots.userData, chosen, relPath, text, kind);
  wrote("Personal/12-standup.md", mirrored(12));
  wrote("Personal/12-standup-transcript.md", transcriptOf("Standup"), "transcript");
  // Re-saved by an editor with a BOM and Windows line endings: still the mirror's.
  wrote("Work/7-plan.md", mirrored(7));
  seed(path.join(chosen, "Work", "7-plan.md"), `\uFEFF${mirrored(7).replaceAll("\n", "\r\n")}`);
  // The workspace and space layout nests a note's folders.
  const space = path.join(chosen, "Workspaces", "Acme", "Teamspaces", "Sales");
  wrote("Workspaces/Acme/Teamspaces/Sales/Calls/21-call.md", mirrored(21, 'space: "Sales"\n'));
  wrote("Workspaces/Acme/Teamspaces/.NET Platform/6-x.md", mirrored(6));
  wrote("Workspaces/Acme", "", "dir");
  seed(path.join(space, "notes.txt"), "mine");
  // Edited since the mirror wrote it, and a copy it kept aside after an
  // outside edit: both may be the only copy of that edit.
  wrote("Personal/15-retro.md", mirrored(15));
  seed(path.join(chosen, "Personal", "15-retro.md"), `${mirrored(15)}\n\nmy edit`);
  seed(path.join(space, "edited-22-brief.md"), `${mirrored(22)}\n\nedited`);
  // The user's own files, one with exactly the mirror's frontmatter and name
  // shape, and a folder they left empty.
  seed(path.join(chosen, "Zettel", "202311151230-idea.md"), mirrored(202311151230));
  seed(path.join(chosen, "readme.md"), "mine");
  fs.mkdirSync(path.join(chosen, "Ideas"));
  // Records that lead out of the folder, through ".." or a link, are not followed.
  const outside = path.join(root, "Elsewhere");
  seed(path.join(outside, "3-plan.md"), mirrored(3));
  fs.symlinkSync(outside, path.join(chosen, "Linked"));
  wrote("../Elsewhere/3-plan.md", mirrored(3));
  wrote("Linked/3-plan.md", mirrored(3));
  // A folder the mirror wrote to before it moved to the one above.
  const earlier = path.join(root, "Old notes");
  mirrorWrote(roots.userData, earlier, "Personal/5-retro.md", mirrored(5));

  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
  assert.deepEqual(fs.readdirSync(chosen).sort(), [
    "Ideas",
    "Linked",
    "Personal",
    "Workspaces",
    "Zettel",
    "readme.md",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Personal")), ["15-retro.md"]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Workspaces", "Acme", "Teamspaces")), [
    "Sales",
  ]);
  assert.deepEqual(fs.readdirSync(space).sort(), ["edited-22-brief.md", "notes.txt"]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Zettel")), ["202311151230-idea.md"]);
  assert.deepEqual(fs.readdirSync(outside), ["3-plan.md"]);
  assert.deepEqual(fs.readdirSync(earlier), []);
});

test("a database from before the mirror kept its record wipes without an error", async () => {
  fs.mkdirSync(roots.userData, { recursive: true });
  new (require("better-sqlite3"))(path.join(roots.userData, "transcriptions.db"))
    .exec("CREATE TABLE notes (id INTEGER)")
    .close();
  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
});

// One note that can't go (a folder another tool locked) doesn't keep the rest.
test(
  "a mirrored note that can't be removed is reported, and the others still go",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const chosen = path.join(root, "Vault");
    mirrorWrote(roots.userData, chosen, "Locked/1-a.md", mirrored(1));
    mirrorWrote(roots.userData, chosen, "Open/2-b.md", mirrored(2));
    fs.chmodSync(path.join(chosen, "Locked"), 0o555);
    try {
      const errors = await removeLocalData({ includeModels: false, roots });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^notes mirror: /);
      assert.equal(exists(chosen, "Open"), false);
      assert.equal(exists(chosen, "Locked", "1-a.md"), true);
    } finally {
      fs.chmodSync(path.join(chosen, "Locked"), 0o755);
    }
  }
);

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
  // The API key came from the app that relaunched into the wipe, which had
  // decrypted it from the deleted secure-keys.
  const env = {
    DICTATION_KEY: "F8",
    UI_LANGUAGE: "de",
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-leaver",
  };
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

test(
  "a notes file that can't be read is a failure, not an edit, and stays",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const chosen = path.join(root, "Vault");
    mirrorWrote(roots.userData, chosen, "Personal/1-a.md", mirrored(1));
    const file = path.join(chosen, "Personal", "1-a.md");
    fs.chmodSync(file, 0o000);
    try {
      const errors = await removeLocalData({ includeModels: false, roots });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^notes mirror: /);
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  }
);

test(
  "a notes folder that now leads elsewhere is reported, and nothing there is removed",
  { skip: process.platform === "win32" },
  async () => {
    const chosen = path.join(root, "Vault");
    mirrorWrote(roots.userData, chosen, "Personal/1-a.md", mirrored(1));
    const backup = path.join(root, "Backup");
    fs.renameSync(chosen, backup);
    fs.symlinkSync(backup, chosen);
    assert.deepEqual(await removeLocalData({ includeModels: false, roots }), [
      "notes mirror: The notes folder now leads elsewhere",
    ]);
    assert.equal(exists(backup, "Personal", "1-a.md"), true);
  }
);

test("an AuditLogPath inside a folder the wipe removes keeps its history and gets the wipe's line", async () => {
  seedDevice();
  const auditLogPath = path.join(roots.userData, "logs", "audit");
  seed(path.join(auditLogPath, "meeting-audit-it-2026-11-01.jsonl"), "{}\n");
  assert.equal(
    await launchHarness({ snapshot: managed("offboard-1", { auditLogPath }) }).wipe(),
    true
  );
  assert.deepEqual(fs.readdirSync(path.join(roots.userData, "logs")), ["audit"]);
  const kept = fs.readdirSync(auditLogPath);
  assert.equal(kept.length, 2);
  assert.ok(kept.includes("meeting-audit-it-2026-11-01.jsonl"));
  const wiped = kept.find((name) => name !== "meeting-audit-it-2026-11-01.jsonl");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(auditLogPath, wiped), "utf8")).event,
    "local-data.wiped"
  );
});

test("WipeLocalDataIncludesModels deployed on its own still takes models with a removal's wipe", async () => {
  const { normalizeDeviceValues } = require("../../src/helpers/managedDevicePolicy");
  seedDevice();
  requestWorkspaceRemovalWipe(roots.userData, {
    accountId: "account-a",
    workspaceId: "ws-1",
    removedAt: "2026-11-12T10:00:00Z",
  });
  const snapshot = normalizeDeviceValues({ WipeLocalDataIncludesModels: true });
  assert.equal(snapshot.status, "absent");
  assert.equal(await launchHarness({ snapshot }).wipe(), true);
  assert.equal(exists(roots.userData, "installed-models.json"), false);
  for (const name of MODEL_CACHE_ENTRIES) assert.equal(exists(roots.homeCache, name), false, name);
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
  // getCacheRoot() can be a folder other apps share, which the wipe only takes models from.
  const cacheRoot = new Set(MODEL_CACHE_ROOT_ENTRIES);
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
    check(/"\.cache",\s*"openwhispr",\s*([^,)]+)/g, (name) => caches.has(name), "cache");
    check(/getCacheRoot\(\),\s*([^,)]+)/g, (name) => cacheRoot.has(name), "cache root");
    check(
      /getModelsDirForService\(("[^"]+")\)/g,
      (name) => cacheRoot.has(`${name}-models`),
      "models"
    );
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
    for (const name of [
      "transcriptions.db",
      "transcriptions.db-wal",
      "transcriptions.db-shm",
      "transcriptions.db-journal",
    ])
      fs.rmSync(path.join(userData, name), { recursive: true });
    const wrote = (base, relPath, text, kind) => mirrorWrote(userData, base, relPath, text, kind);
    wrote(vault, "Personal/12-standup.md", mirrored(12));
    wrote(vault, "Personal/12-standup-transcript.md", transcriptOf("Standup"), "transcript");
    // Re-saved by an editor with a BOM and Windows line endings, alone in its folder.
    wrote(vault, "Work/7-plan.md", mirrored(7));
    seed(path.join(vault, "Work", "7-plan.md"), `\uFEFF${mirrored(7).replaceAll("\n", "\r\n")}`);
    // Edited since the mirror wrote it, and the user's own note with exactly
    // the mirror's frontmatter.
    wrote(vault, "Personal/15-retro.md", mirrored(15));
    seed(path.join(vault, "Personal", "15-retro.md"), `${mirrored(15)}\n\nmy edit`);
    seed(path.join(vault, "Zettel", "202311151230-idea.md"), mirrored(202311151230));
    // Records that lead out of the folder, through ".." or a link, are not followed.
    const beside = path.join(home, "Documents", "Elsewhere");
    wrote(vault, "../Elsewhere/3-plan.md", mirrored(3));
    fs.symlinkSync(beside, path.join(vault, "Linked"));
    wrote(vault, "Linked/3-plan.md", mirrored(3));
    // Run as root, the script never follows a record out of the user's home.
    const outside = path.join(root, "Shared");
    wrote(outside, "Team/3-plan.md", mirrored(3));
    // Never the real app: process lookups see nothing running.
    const bin = path.join(root, "bin");
    const tools = { pgrep: "exit 1", pkill: "exit 1" };
    if (process.platform !== "darwin") {
      // macOS's stat, from Linux's.
      tools.stat = '[ "$1" = -f ] && shift && set -- -c "$@"\nexec /usr/bin/stat "$@"';
    }
    for (const [tool, body] of Object.entries(tools)) {
      seed(path.join(bin, tool), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, tool), 0o755);
    }
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

    // A home named by mistake fails the run rather than reporting it wiped.
    assert.throws(
      () => run(path.join(root, "no-such-home")),
      (error) => error.status === 1 && error.stderr.includes("No such home")
    );
    run(home);
    // From a version before the mirror kept its record: nothing to name, no failure.
    const older = path.join(root, "older-home");
    const olderData = path.join(older, "Library", "Application Support", "OpenWhispr");
    fs.mkdirSync(olderData, { recursive: true });
    new (require("better-sqlite3"))(path.join(olderData, "transcriptions.db"))
      .exec("CREATE TABLE notes (id INTEGER)")
      .close();
    run(older);
    assert.deepEqual(fs.readdirSync(olderData), []);
    assert.deepEqual(
      fs.readdirSync(userData).sort(),
      [...KEPT_USER_DATA_ENTRIES, ...MODEL_USER_DATA_ENTRIES].sort()
    );
    assert.deepEqual(fs.readdirSync(cache).sort(), [...MODEL_CACHE_ENTRIES].sort());
    assert.deepEqual(fs.readdirSync(path.join(home, ".openwhispr")), ["cli-config.json"]);
    assert.deepEqual(fs.readdirSync(vault).sort(), ["Linked", "Personal", "Zettel"]);
    assert.deepEqual(fs.readdirSync(path.join(vault, "Personal")), ["15-retro.md"]);
    assert.deepEqual(fs.readdirSync(path.join(vault, "Zettel")), ["202311151230-idea.md"]);
    assert.deepEqual(fs.readdirSync(beside), ["3-plan.md"]);
    assert.deepEqual(fs.readdirSync(path.join(outside, "Team")), ["3-plan.md"]);

    // A folder the user replaced with a symlink is not followed out of the home,
    // and the skip fails the device so the MDM tool doesn't show it as wiped.
    const linked = path.join(root, "linked-home");
    const elsewhere = path.join(root, "elsewhere");
    seed(path.join(linked, "Library", "Application Support", "OpenWhispr", "audio", "1.webm"));
    seed(path.join(elsewhere, "openwhispr", "qdrant-data", "item"));
    fs.symlinkSync(elsewhere, path.join(linked, ".cache"));
    assert.throws(
      () => run(linked),
      (error) =>
        error.status === 1 &&
        error.stderr.includes("Skipped") &&
        !error.stdout.includes("Removed OpenWhispr local data")
    );
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

test(
  "the macOS script quits only its home's owner's app, and a note it can't read fails the run",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const { execFileSync } = require("node:child_process");
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "OpenWhispr");
    const vault = path.join(home, "Documents", "Vault");
    mirrorWrote(userData, vault, "Personal/1-a.md", mirrored(1));
    const note = path.join(vault, "Personal", "1-a.md");
    const lookups = path.join(root, "process-lookups.log");
    const bin = path.join(root, "bin");
    const tools = { pgrep: `echo "$*" >> "${lookups}"\nexit 1`, pkill: "exit 1" };
    if (process.platform !== "darwin") {
      // macOS's stat, from Linux's.
      tools.stat = '[ "$1" = -f ] && shift && set -- -c "$@"\nexec /usr/bin/stat "$@"';
    }
    for (const [tool, body] of Object.entries(tools)) {
      seed(path.join(bin, tool), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, tool), 0o755);
    }
    fs.chmodSync(note, 0o000);
    try {
      assert.throws(
        () =>
          execFileSync(
            "/bin/bash",
            [path.join(__dirname, "../../scripts/mdm/wipe-local-data-macos.sh"), home],
            {
              cwd: root,
              env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
              encoding: "utf8",
            }
          ),
        (error) =>
          error.status === 1 &&
          error.stderr.includes("Could not read") &&
          !error.stdout.includes("Removed OpenWhispr local data")
      );
      assert.equal(fs.existsSync(note), true);
      assert.deepEqual(fs.readFileSync(lookups, "utf8").trim().split("\n"), [
        `-U ${process.getuid()} -f OpenWhispr.app/Contents/`,
      ]);
    } finally {
      fs.chmodSync(note, 0o644);
    }
  }
);
