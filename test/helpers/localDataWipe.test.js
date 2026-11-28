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

// #3323: IT wipes a leaver's local OpenWhispr data through MDM or by removing
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
    sharedTemp: [path.join(root, "shared-temp")],
    mounts: [],
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
  for (const temp of [roots.temp[0], roots.sharedTemp[0]])
    for (const prefix of TEMP_PREFIXES) seed(path.join(temp, `${prefix}1.wav`));
  seed(path.join(roots.temp[0], "another-app.tmp"));
}

const exists = (...parts) => fs.existsSync(path.join(...parts));

test("removes every store and keeps the audit log, the wipe record and, by default, models", async () => {
  seedDevice();
  for (const name of ["local-data-wipe.json", "local-data-wipe.json.tmp"])
    seed(path.join(roots.userData, name), "{}");
  seed(path.join(roots.userData, "local-data-wipe.pending"), "");
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
  assert.deepEqual(fs.readdirSync(roots.sharedTemp[0]), []);

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
  // A folder of notes with none in it yet: its name goes with it, two leading
  // dots or not.
  wrote("Workspaces/Acme/Private/Board - layoffs", "", "dir");
  wrote("..Board", "", "dir");
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
  // Records that lead out of the folder, through ".." or a link, are not
  // followed. A folder the user moved elsewhere and left a link in place of
  // is reported, and the database still goes.
  const outside = path.join(root, "Elsewhere");
  seed(path.join(outside, "3-plan.md"), mirrored(3));
  fs.symlinkSync(outside, path.join(chosen, "Linked"));
  wrote("../Elsewhere/3-plan.md", mirrored(3));
  wrote("Linked/3-plan.md", mirrored(3));
  wrote("Linked/4-call.md", mirrored(4));
  // A folder the mirror wrote to before it moved to the one above.
  const earlier = path.join(root, "Old notes");
  mirrorWrote(roots.userData, earlier, "Personal/5-retro.md", mirrored(5));

  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), [
    `notes mirror: ${path.join(fs.realpathSync(chosen), "Linked")} now leads elsewhere, so its notes weren't removed`,
  ]);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.deepEqual(fs.readdirSync(chosen).sort(), [
    "Ideas",
    "Linked",
    "Personal",
    "Workspaces",
    "Zettel",
    "readme.md",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Personal")), ["15-retro.md"]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Workspaces", "Acme")), ["Teamspaces"]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Workspaces", "Acme", "Teamspaces")), [
    "Sales",
  ]);
  assert.deepEqual(fs.readdirSync(space).sort(), ["edited-22-brief.md", "notes.txt"]);
  assert.deepEqual(fs.readdirSync(path.join(chosen, "Zettel")), ["202311151230-idea.md"]);
  assert.deepEqual(fs.readdirSync(outside).sort(), ["3-plan.md", "4-call.md"]);
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

// Without it, a retry couldn't tell which files are the mirror's.
test("a database it can't read is reported and kept for the retry", async () => {
  seed(path.join(roots.userData, "transcriptions.db"), "not a database");
  const errors = await removeLocalData({ includeModels: false, roots });
  assert.equal(errors.length, 1);
  assert.ok(
    errors[0].startsWith(`notes mirror: ${path.join(roots.userData, "transcriptions.db")}: `)
  );
  assert.equal(exists(roots.userData, "transcriptions.db"), true);
});

// One note that can't go (a folder another tool locked) doesn't keep the rest,
// and the database that records it stays for the next launch's retry.
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
      assert.equal(exists(roots.userData, "transcriptions.db"), true);
    } finally {
      fs.chmodSync(path.join(chosen, "Locked"), 0o755);
    }
  }
);

// A notes folder the user deleted, its parent too, took its notes with it. One
// on a drive that isn't connected still holds them: it is reported, and the
// database still goes, since keeping it would keep every note on the device.
test("a deleted notes folder wipes, and one on a drive that isn't connected is reported", async () => {
  const deleted = path.join(root, "Dropbox", "Vault");
  mirrorWrote(roots.userData, deleted, "Personal/1-a.md", mirrored(1));
  fs.rmSync(path.join(root, "Dropbox"), { recursive: true });
  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);

  // A vault at the root of a drive, ejected.
  const volumes = path.join(root, "Volumes");
  const drive = path.join(volumes, "USB");
  mirrorWrote(roots.userData, drive, "Personal/2-b.md", mirrored(2));
  const recorded = fs.realpathSync(drive);
  roots.mounts = [fs.realpathSync(volumes)];
  fs.renameSync(drive, path.join(root, "ejected"));
  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), [
    `notes mirror: The notes folder ${recorded} can't be reached`,
  ]);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
});

// Not every unreachable drive says "not found": Windows answers UNKNOWN for a
// share it can't reach.
test(
  "a notes folder on a drive that fails another way is reported the same",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const volumes = path.join(root, "Volumes");
    const share = path.join(volumes, "Share");
    mirrorWrote(roots.userData, path.join(share, "Vault"), "3-c.md", mirrored(3));
    const recorded = fs.realpathSync(path.join(share, "Vault"));
    roots.mounts = [fs.realpathSync(volumes)];
    fs.chmodSync(share, 0o000);
    try {
      assert.deepEqual(await removeLocalData({ includeModels: false, roots }), [
        `notes mirror: The notes folder ${recorded} can't be reached`,
      ]);
      assert.equal(exists(roots.userData, "transcriptions.db"), false);
    } finally {
      fs.chmodSync(share, 0o755);
    }
  }
);

// getCacheRoot() falls back on Windows to a folder every account there writes in.
test(
  "on Windows, a model this user may not delete in the separate model cache root is another account's",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const models = path.join(roots.cacheRoot, "whisper-models");
    seed(path.join(models, "other.bin"));
    fs.chmodSync(models, 0o555);
    const { getuid } = process;
    process.getuid = undefined;
    try {
      assert.deepEqual(await removeLocalData({ includeModels: true, roots }), []);
      assert.equal(exists(models, "other.bin"), true);
    } finally {
      process.getuid = getuid;
      fs.chmodSync(models, 0o755);
    }
  }
);

// Recordings moved to another drive, say: the wipe never goes through a link.
test(
  "a store the user replaced with a link is reported, and what it leads to stays",
  { skip: process.platform === "win32" },
  async () => {
    const elsewhere = path.join(root, "external", "audio");
    seed(path.join(elsewhere, "1.webm"));
    fs.mkdirSync(roots.userData, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(roots.userData, "audio"));
    assert.deepEqual(await removeLocalData({ includeModels: false, roots }), [
      `audio: it led to ${elsewhere}, which wasn't removed`,
    ]);
    assert.equal(exists(roots.userData, "audio"), false);
    assert.equal(exists(elsewhere, "1.webm"), true);
    assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
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

// Outside damage (a restore, a hand edit) can leave the record holding no
// record; wiping again would wipe whoever uses the device now.
test("a wipe record it can't parse counts the deployed token as acted on", async () => {
  const statePath = path.join(roots.userData, "local-data-wipe.json");
  for (const damage of ["", '{"token":"offboard-1"', "[]", "null"]) {
    seedDevice();
    seed(statePath, damage);
    assert.equal(await launchHarness({ snapshot: managed("offboard-1") }).wipe(), false);
    assert.equal(exists(roots.userData, "transcriptions.db"), true);
    // Replaced by what it can tell, so a later token still wipes.
    assert.deepEqual(wipeState(), { token: "offboard-1" });
  }
  assert.equal(await launchHarness({ snapshot: managed("offboard-2") }).wipe(), true);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  // With a policy it can't read, there is no token to put in its place.
  seedDevice();
  seed(statePath, "");
  assert.equal(await launchHarness({ readError: new Error("unreadable") }).wipe(), false);
  assert.equal(fs.readFileSync(statePath, "utf8"), "");
  // With none deployed, a first token deployed later still wipes.
  assert.equal(
    await launchHarness({ snapshot: { status: "absent", managed: false, policy: null } }).wipe(),
    false
  );
  assert.deepEqual(wipeState(), {});
  seed(statePath, "");
  assert.equal(await launchHarness({ snapshot: managed(null) }).wipe(), false);
  assert.deepEqual(wipeState(), {});
  assert.equal(await launchHarness({ snapshot: managed("offboard-3") }).wipe(), true);
});

test(
  "a wipe record it can't open wipes for no token, and a script's marker still wipes",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    seedDevice();
    const statePath = path.join(roots.userData, "local-data-wipe.json");
    seed(statePath, '{"token":"offboard-1"}');
    fs.chmodSync(statePath, 0o000);
    try {
      assert.equal(await launchHarness({ snapshot: managed("offboard-2") }).wipe(), false);
      assert.equal(exists(roots.userData, "transcriptions.db"), true);
      // Left as it is: replacing it would drop what it holds.
      assert.equal(fs.statSync(statePath).mode & 0o777, 0);
      seed(path.join(roots.userData, "local-data-wipe.pending"), "");
      assert.equal(await launchHarness({ snapshot: managed("offboard-2") }).wipe(), true);
      assert.equal(exists(roots.userData, "transcriptions.db"), false);
    } finally {
      fs.chmodSync(statePath, 0o644);
    }
  }
);

// Antivirus or a backup tool can hold the record open for a moment.
test(
  "a wipe record held open a moment is read again, so an unfinished wipe still retries",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    seedDevice();
    const statePath = path.join(roots.userData, "local-data-wipe.json");
    seed(
      statePath,
      JSON.stringify({
        pendingToken: "offboard-1",
        pendingSettings: { includeModels: false, auditLogPath: null },
      })
    );
    fs.chmodSync(statePath, 0o000);
    setTimeout(() => fs.chmodSync(statePath, 0o644), 50);
    assert.equal(await launchHarness({ snapshot: managed("offboard-1") }).wipe(), true);
    assert.equal(exists(roots.userData, "transcriptions.db"), false);
    assert.deepEqual(wipeState(), { token: "offboard-1" });
  }
);

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

// #3323's second trigger: a running app that hears its account was removed
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

  // .env may name the channel too, and its values are dropped before the relaunch.
  seedDevice();
  fs.rmSync(path.join(roots.userData, ".env"), { recursive: true });
  seed(path.join(roots.userData, ".env"), "OPENWHISPR_CHANNEL=staging\n");
  const named = launchHarness({
    snapshot: managed("offboard-2"),
    env: { OPENWHISPR_CHANNEL: "staging" },
  });
  assert.equal(await named.wipe(), true);
  assert.equal(named.calls.includes("master key"), false);
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

const wipeState = () =>
  JSON.parse(fs.readFileSync(path.join(roots.userData, "local-data-wipe.json"), "utf8"));
const failingBrowserData = async () => {
  throw new Error("session unavailable");
};

test("a wipe that leaves a store behind keeps the app closed and its token pending", async () => {
  seedDevice();
  const failing = launchHarness({
    snapshot: managed("offboard-1"),
    clearBrowserData: failingBrowserData,
  });
  await assert.rejects(failing.wipe(), {
    message: "Local data wipe incomplete",
    errors: ["browser data: session unavailable"],
  });
  assert.deepEqual(wipeState(), {
    pendingToken: "offboard-1",
    pendingSettings: { includeModels: false, auditLogPath: null },
  });
  // The next launch tries again, and finishes, even when it can't read the policy.
  seed(path.join(roots.userData, "transcriptions.db"));
  const unreadable = launchHarness({ readError: new Error("Managed policy reader unavailable") });
  assert.equal(await unreadable.wipe(), true);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.deepEqual(wipeState(), { token: "offboard-1" });
  assert.deepEqual(
    auditLines().map((line) => line.reason),
    ["incomplete", null]
  );
});

test("a removal's wipe leaves its notice only once nothing was left behind", async () => {
  seedDevice();
  requestWorkspaceRemovalWipe(roots.userData, {
    accountId: "account-a",
    workspaceId: "ws-1",
    removedAt: "2026-11-12T10:00:00Z",
  });
  const harness = (clearBrowserData) =>
    launchHarness({ readError: new Error("unreadable"), clearBrowserData });
  await assert.rejects(harness(failingBrowserData).wipe());
  assert.equal(takeWipeNotice(roots.userData), null);
  assert.equal(wipeState().pendingRemoval.workspaceId, "ws-1");
  assert.equal(await harness().wipe(), true);
  assert.equal(takeWipeNotice(roots.userData), "workspace-removal");
  assert.equal(await harness().wipe(), false);
});

// An MDM script that couldn't finish a home leaves its marker there, and the
// app finishes the wipe before anything opens what is left.
test("a script's marker makes the app finish the wipe, and goes once it is done", async () => {
  seedDevice();
  const marker = path.join(roots.userData, "local-data-wipe.pending");
  seed(marker, "");
  const harness = (clearBrowserData) =>
    launchHarness({ readError: new Error("unreadable"), clearBrowserData });
  await assert.rejects(harness(failingBrowserData).wipe());
  assert.equal(fs.existsSync(marker), true);
  assert.equal(await harness().wipe(), true);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.deepEqual(
    auditLines().map((line) => [line.trigger, line.reason]),
    [
      ["script", "incomplete"],
      ["script", null],
    ]
  );
  assert.equal(await harness().wipe(), false);
});

// The audit line goes to the record first; one a stalled network share never
// took is written at a later launch, with the time of the wipe, and the app
// opens meanwhile.
test("a wipe line an unresponsive AuditLogPath didn't take is written at a later launch", async () => {
  seedDevice();
  const auditLogPath = path.join(root, "share");
  const open = fs.promises.open;
  let stalled = 0;
  fs.promises.open = (file, ...rest) =>
    String(file).startsWith(auditLogPath)
      ? (stalled++, new Promise(() => {}))
      : open(file, ...rest);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms, "waiting"));
  try {
    const snapshot = managed("offboard-1", { auditLogPath });
    assert.equal(await launchHarness({ snapshot }).wipe(), true);
    const [pending] = wipeState().pendingAudit;
    assert.deepEqual({ ...pending, at: 0 }, { trigger: "device-policy", incomplete: false, at: 0 });
    // Still stalled: the next launch opens without waiting on it.
    assert.equal(await Promise.race([launchHarness({ snapshot }).wipe(), sleep(1000)]), false);
    for (let tries = 0; stalled < 2 && tries < 100; tries++) await sleep(10);
    assert.equal(stalled, 2);
    fs.promises.open = open;
    assert.equal(await launchHarness({ snapshot }).wipe(), false);
    for (let tries = 0; wipeState().pendingAudit && tries < 100; tries++) await sleep(10);
    assert.deepEqual(wipeState(), { token: "offboard-1" });
    const [file] = fs.readdirSync(auditLogPath);
    const line = JSON.parse(fs.readFileSync(path.join(auditLogPath, file), "utf8"));
    assert.equal(line.event, "local-data.wiped");
    assert.equal(line.ts, new Date(pending.at).toISOString());
  } finally {
    fs.promises.open = open;
  }
});

test(
  "a notes file or folder that can't be read is a failure, not an edit, and keeps the database",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    // Two folders, so each fails on its own.
    const chosen = path.join(root, "Vault");
    const other = path.join(root, "Other");
    mirrorWrote(roots.userData, chosen, "Personal/1-a.md", mirrored(1));
    mirrorWrote(roots.userData, other, "Closed/2-b.md", mirrored(2));
    const file = path.join(chosen, "Personal", "1-a.md");
    const folder = path.join(other, "Closed");
    fs.chmodSync(file, 0o000);
    fs.chmodSync(folder, 0o000);
    try {
      const errors = await removeLocalData({ includeModels: false, roots });
      assert.equal(errors.length, 2);
      for (const error of errors) assert.match(error, /^notes mirror: /);
      assert.equal(fs.existsSync(file), true);
      fs.chmodSync(folder, 0o755);
      assert.equal(exists(folder, "2-b.md"), true);
      assert.equal(exists(roots.userData, "transcriptions.db"), true);
    } finally {
      fs.chmodSync(file, 0o644);
      fs.chmodSync(folder, 0o755);
    }
  }
);

// One it can't list, or whose entries it can't look at, may still hold this
// user's recordings.
test(
  "a temp folder it can't read is reported, not taken for an empty one",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const recording = path.join(roots.temp[0], "ow-recording.webm");
    for (const [mode, reported] of [
      [0o000, /^temp files: EACCES/],
      [0o400, /^ow-recording\.webm: EACCES/],
    ]) {
      seed(recording);
      fs.chmodSync(roots.temp[0], mode);
      try {
        const errors = await removeLocalData({ includeModels: false, roots });
        assert.equal(errors.length, 1);
        assert.match(errors[0], reported);
      } finally {
        fs.chmodSync(roots.temp[0], 0o755);
      }
      assert.equal(fs.existsSync(recording), true);
    }
  }
);

// Linux's /tmp is every account's.
test(
  "a temp file another account owns is left alone",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const other = path.join(roots.temp[0], "ow-other.wav");
    seed(other);
    const { getuid } = process;
    const uid = getuid();
    process.getuid = () => uid + 1;
    try {
      assert.deepEqual(await removeLocalData({ includeModels: false, roots }), []);
      assert.equal(fs.existsSync(other), true);
    } finally {
      process.getuid = getuid;
    }
  }
);

// Windows has no owner to check, and the temp folder getSafeTempDir() falls back
// to is every such account's. The user's own temp folder is theirs alone.
test(
  "on Windows, a temp file this user may not delete is another account's only in the shared temp folder",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const folders = [roots.temp[0], roots.sharedTemp[0]];
    for (const folder of folders) {
      seed(path.join(folder, "whisper-input-other.wav"));
      fs.chmodSync(folder, 0o555);
    }
    const { getuid } = process;
    process.getuid = undefined;
    try {
      const errors = await removeLocalData({ includeModels: false, roots });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^whisper-input-other\.wav: /);
      assert.ok(errors[0].includes(roots.temp[0]));
      for (const folder of folders) assert.equal(exists(folder, "whisper-input-other.wav"), true);
    } finally {
      process.getuid = getuid;
      for (const folder of folders) fs.chmodSync(folder, 0o755);
    }
  }
);

test(
  "a notes folder that now leads elsewhere is reported, and nothing there is removed",
  { skip: process.platform === "win32" },
  async () => {
    const chosen = path.join(root, "Vault");
    mirrorWrote(roots.userData, chosen, "Personal/1-a.md", mirrored(1));
    const recorded = fs.realpathSync(chosen);
    const backup = path.join(root, "Backup");
    fs.renameSync(chosen, backup);
    fs.symlinkSync(backup, chosen);
    assert.deepEqual(await removeLocalData({ includeModels: false, roots }), [
      `notes mirror: The notes folder ${recorded} now leads elsewhere`,
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

// Only the audit files are the audit log's: the store it shares a folder with
// is still wiped.
test("an AuditLogPath that is a store's own folder keeps only the audit files there", async () => {
  for (const store of ["logs", "audio"]) {
    seedDevice();
    const auditLogPath = path.join(roots.userData, store);
    seed(path.join(auditLogPath, "meeting-audit-it-2026-11-01.jsonl"), "{}\n");
    assert.deepEqual(
      await removeLocalData({ includeModels: false, roots, auditLogPath }),
      [],
      store
    );
    assert.deepEqual(fs.readdirSync(auditLogPath), ["meeting-audit-it-2026-11-01.jsonl"], store);
    fs.rmSync(roots.userData, { recursive: true });
  }
  // A folder whose name starts with two dots is still inside.
  seedDevice();
  const auditLogPath = path.join(roots.userData, "logs", "..audit");
  seed(path.join(auditLogPath, "meeting-audit-it-2026-11-01.jsonl"), "{}\n");
  assert.deepEqual(await removeLocalData({ includeModels: false, roots, auditLogPath }), []);
  assert.deepEqual(fs.readdirSync(auditLogPath), ["meeting-audit-it-2026-11-01.jsonl"]);
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

const recordFailed = ({ errors }) => errors.length === 1 && /^wipe record: /.test(errors[0]);

// A full disk mustn't keep the data the wipe is for.
test("a wipe it can't put on record still removes the data, and keeps the app closed", async () => {
  seedDevice();
  // A folder where the record is written first: every write fails, as on a
  // full or read-only disk.
  fs.mkdirSync(path.join(roots.userData, "local-data-wipe.json.tmp"));
  await assert.rejects(launchHarness({ snapshot: managed("offboard-1") }).wipe(), recordFailed);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
});

test("a wipe whose start can't be recorded opens the app once its end is", async () => {
  seedDevice();
  const pending = path.join(roots.userData, "local-data-wipe.json.tmp");
  fs.mkdirSync(pending);
  const harness = launchHarness({
    snapshot: managed("offboard-1"),
    clearBrowserData: async () => fs.rmdirSync(pending),
  });
  assert.equal(await harness.wipe(), true);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.deepEqual(wipeState(), { token: "offboard-1" });
});

// Otherwise the app would open, and the retry would take what the user did since.
test("a wipe whose end can't be recorded keeps the app closed, and the next launch finishes it", async () => {
  seedDevice();
  const record = path.join(roots.userData, "local-data-wipe.json");
  // The disk stops taking the record once the wipe has begun.
  const harness = launchHarness({
    snapshot: managed("offboard-1"),
    clearBrowserData: async () => fs.mkdirSync(`${record}.tmp`),
  });
  await assert.rejects(harness.wipe(), recordFailed);
  assert.equal(exists(roots.userData, "transcriptions.db"), false);
  assert.equal(wipeState().pendingToken, "offboard-1");
  fs.rmdirSync(`${record}.tmp`);
  assert.equal(await launchHarness({ readError: new Error("unreadable") }).wipe(), true);
  assert.deepEqual(wipeState(), { token: "offboard-1" });
  assert.deepEqual(
    auditLines().map((line) => line.reason),
    ["incomplete", null]
  );
});

// The policy may be gone or unreadable by the retry.
test("a retry takes what its wipe was asked to and keeps its audit files, whatever the policy reads then", async () => {
  seedDevice();
  const auditLogPath = path.join(roots.userData, "logs", "audit");
  seed(path.join(auditLogPath, "meeting-audit-it-2026-11-01.jsonl"), "{}\n");
  const snapshot = managed("offboard-1", { wipeLocalDataIncludesModels: true, auditLogPath });
  await assert.rejects(launchHarness({ snapshot, clearBrowserData: failingBrowserData }).wipe());
  // A model that was in use, and a log written since.
  seed(path.join(roots.homeCache, "whisper-models", "item"));
  seed(path.join(roots.userData, "logs", "debug.log"));
  assert.equal(await launchHarness({ readError: new Error("unreadable") }).wipe(), true);
  assert.equal(exists(roots.homeCache, "whisper-models"), false);
  assert.equal(exists(roots.userData, "logs", "debug.log"), false);
  assert.ok(fs.readdirSync(auditLogPath).includes("meeting-audit-it-2026-11-01.jsonl"));
  assert.deepEqual(wipeState(), { token: "offboard-1" });
});

// The marker goes before the end record, so a crash between the two leaves the
// saved settings for the retry rather than a marker whose settings the policy
// then decides.
test("a marker the wipe can't remove leaves its saved settings for the retry", async () => {
  seedDevice();
  seed(path.join(roots.userData, "local-data-wipe.pending", "stuck"), "");
  const snapshot = { ...managed(null), wipeLocalDataIncludesModels: true };
  await assert.rejects(
    launchHarness({ snapshot }).wipe(),
    ({ errors }) => errors.length === 1 && /^script marker: /.test(errors[0])
  );
  assert.deepEqual(
    auditLines().map((line) => line.reason),
    ["incomplete"]
  );
  seed(path.join(roots.homeCache, "whisper-models", "item"));
  await assert.rejects(launchHarness({ readError: new Error("unreadable") }).wipe());
  assert.equal(exists(roots.homeCache, "whisper-models"), false);
});

// A script that finished took its marker after the app's own try at it failed.
test("a wipe started for a marker a script has since taken still finishes", async () => {
  seedDevice();
  const marker = path.join(roots.userData, "local-data-wipe.pending");
  seed(marker, "");
  const harness = (clearBrowserData) =>
    launchHarness({ readError: new Error("unreadable"), clearBrowserData });
  await assert.rejects(harness(failingBrowserData).wipe());
  fs.rmSync(marker);
  assert.equal(await harness().wipe(), true);
  assert.deepEqual(wipeState(), {});
  assert.equal(await harness().wipe(), false);
});

test("a new token after a wipe that stopped short brings its own settings", async () => {
  seedDevice();
  await assert.rejects(
    launchHarness({ snapshot: managed("offboard-1"), clearBrowserData: failingBrowserData }).wipe()
  );
  const snapshot = managed("offboard-2", { wipeLocalDataIncludesModels: true });
  assert.equal(await launchHarness({ snapshot }).wipe(), true);
  assert.equal(exists(roots.userData, "installed-models.json"), false);
  assert.deepEqual(wipeState(), { token: "offboard-2" });
});

test("a wipe line no audit folder took stays in the record for a later launch", async () => {
  seedDevice();
  // A file where the audit folder goes: the line can't be written anywhere.
  fs.rmSync(path.join(roots.userData, "audit"), { recursive: true });
  seed(path.join(roots.userData, "audit"));
  assert.equal(await launchHarness({ snapshot: managed("offboard-1") }).wipe(), true);
  assert.equal(wipeState().pendingAudit.length, 1);
  fs.rmSync(path.join(roots.userData, "audit"));
  assert.equal(await launchHarness({ snapshot: managed("offboard-1") }).wipe(), false);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let tries = 0; wipeState().pendingAudit && tries < 100; tries++) await sleep(10);
  assert.deepEqual(wipeState(), { token: "offboard-1" });
  assert.equal(auditLines().length, 1);
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
  // One read of the device policy serves the wipe and the device policy's first snapshot.
  at("readDevicePolicy: async () => normalizeDeviceValues(await launchDeviceRead)");
  assert.ok(main.includes("const read = launchDeviceRead ?? readDeviceValues();"));
  // The dialog of a wipe that didn't finish speaks the user's language, read
  // before the wipe took .env's values out of the environment.
  assert.ok(at("const uiLanguage = process.env.UI_LANGUAGE || app.getLocale();") < wipe);
  assert.ok(at("changeLanguage(uiLanguage);") < at("dialog.showErrorBox("));
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

// Electron names the data folder after package.json's productName, else its name.
test("the MDM scripts clean the data folder the app writes", () => {
  const { name, productName } = require("../../package.json");
  const folder = productName ?? name;
  const scripts = path.join(__dirname, "../../scripts/mdm");
  const bash = fs.readFileSync(path.join(scripts, "wipe-local-data-macos.sh"), "utf8");
  const powershell = fs.readFileSync(path.join(scripts, "wipe-local-data-windows.ps1"), "utf8");
  assert.ok(bash.includes(`data_folder="Library/Application Support/${folder}"`));
  assert.ok(powershell.includes(`"AppData\\Roaming\\${folder}"`));
});

// The macOS script with stand-ins for what it reaches outside the home: never
// the real app (process lookups see nothing running unless a tool says so), no
// managed preferences, and macOS's stat from Linux's.
function macosScript(tools = {}) {
  const { execFileSync } = require("node:child_process");
  const bin = path.join(root, "bin");
  const stubs = { pgrep: "exit 1", pkill: "exit 1", defaults: "exit 1", ...tools };
  if (process.platform !== "darwin") {
    stubs.stat = '[ "$1" = -f ] && shift && set -- -c "$@"\nexec /usr/bin/stat "$@"';
  }
  for (const [tool, body] of Object.entries(stubs)) {
    seed(path.join(bin, tool), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  return (...args) =>
    execFileSync(
      "/bin/bash",
      [path.join(__dirname, "../../scripts/mdm/wipe-local-data-macos.sh"), ...args],
      {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      }
    );
}

// The database records the notes folder as the disk spells it.
test(
  "the macOS script cleans a home's notes however the home is typed",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "open-whispr");
    mirrorWrote(userData, path.join(home, "Vault"), "Personal/1-a.md", mirrored(1));
    if (!fs.existsSync(path.join(root, "HOME"))) return t.skip("case-sensitive volume");
    macosScript()(path.join(root, "HOME"));
    assert.equal(exists(home, "Vault", "Personal", "1-a.md"), false);
  }
);

// So a run cut short, by a restart or a stopped job, leaves the app to finish.
test(
  "the macOS script marks a home before it removes anything there",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const userData = path.join(root, "home", "Library", "Application Support", "open-whispr");
    seed(path.join(userData, "audio", "1.webm"));
    const marker = path.join(userData, "local-data-wipe.pending");
    const seen = path.join(root, "marked-at-first-removal");
    macosScript({
      rm: `[ -e "${seen}" ] || { [ -e "${marker}" ] && echo yes || echo no; } > "${seen}"\nexec /bin/rm "$@"`,
    })(path.join(root, "home"));
    assert.equal(fs.readFileSync(seen, "utf8").trim(), "yes");
    assert.equal(fs.existsSync(marker), false);
  }
);

test(
  "the macOS script leaves a home it can't mark as it is",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const home = path.join(root, "home");
    const real = path.join(root, "elsewhere-data");
    seed(path.join(real, "audio", "1.webm"));
    seed(path.join(home, ".cache", "openwhispr", "qdrant-data", "item"));
    fs.mkdirSync(path.join(home, "Library", "Application Support"), { recursive: true });
    fs.symlinkSync(real, path.join(home, "Library", "Application Support", "open-whispr"));
    assert.throws(
      () => macosScript()(home),
      (error) => error.status === 1 && error.stderr.includes("can't be marked")
    );
    assert.equal(exists(real, "audio", "1.webm"), true);
    assert.equal(exists(home, ".cache", "openwhispr", "qdrant-data", "item"), true);
  }
);

test(
  "the macOS script empties a home's OpenWhispr data and keeps what the app keeps",
  { skip: process.platform === "win32" },
  async () => {
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "open-whispr");
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
    // Titles keep their dashes and scripts.
    wrote(vault, "Personal/16-standup-–-monday.md", mirrored(16));
    wrote(vault, "Personal/17-会议.md", mirrored(17));
    seed(path.join(vault, "Zettel", "202311151230-idea.md"), mirrored(202311151230));
    // A record that leads out of the folder through ".." is not followed.
    const beside = path.join(home, "Documents", "Elsewhere");
    wrote(vault, "../Elsewhere/3-plan.md", mirrored(3));
    // A folder of notes with none in it yet: its name goes with it.
    wrote(vault, "Workspaces/Acme/Private/Board - layoffs", "", "dir");
    // Chromium's lock links, left by an app that didn't quit cleanly, go unreported.
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      fs.symlinkSync(`host-${name}`, path.join(userData, name));
    const run = macosScript();

    // A home named by mistake fails the run rather than reporting it wiped.
    assert.throws(
      () => run(path.join(root, "no-such-home")),
      (error) => error.status === 1 && error.stderr.includes("No such home")
    );
    // A home named without OpenWhispr data in it gets nothing written there.
    const bare = path.join(root, "bare-home");
    fs.mkdirSync(bare);
    assert.doesNotMatch(run(bare), /Removed/);
    assert.deepEqual(fs.readdirSync(bare), []);
    run(home);
    // From a version before the mirror kept its record: nothing to name, no
    // failure, in a home whose name isn't ASCII.
    const older = path.join(root, "older–home");
    const olderData = path.join(older, "Library", "Application Support", "open-whispr");
    fs.mkdirSync(olderData, { recursive: true });
    new (require("better-sqlite3"))(path.join(olderData, "transcriptions.db"))
      .exec("CREATE TABLE notes (id INTEGER)")
      .close();
    // A rollback journal beside it can't be replayed into the copy the record
    // is read from, which matters only to a database that keeps one.
    seed(path.join(olderData, "transcriptions.db-journal"), "journal");
    run(older);
    // Each wipe is recorded in the home's audit log, as the app records its own.
    const recorded = (data) =>
      fs
        .readdirSync(path.join(data, "audit"))
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) =>
          fs
            .readFileSync(path.join(data, "audit", name), "utf8")
            .trim()
            .split("\n")
        )
        .map((line) => JSON.parse(line));
    assert.deepEqual(fs.readdirSync(olderData), ["audit"]);
    const [olderLine] = recorded(olderData);
    assert.equal(olderLine.event, "local-data.wiped");
    assert.equal(olderLine.trigger, "script");
    assert.equal(olderLine.reason, null);
    assert.equal(olderLine.deviceUser, os.userInfo().username);
    assert.match(
      fs.readdirSync(path.join(olderData, "audit"))[0],
      new RegExp(`^meeting-audit-${os.userInfo().username}-\\d{4}-\\d{2}-\\d{2}\\.jsonl$`)
    );
    // A database it can't read stays, so a run again can still tell what to remove.
    const corrupt = path.join(root, "corrupt-home");
    const corruptData = path.join(corrupt, "Library", "Application Support", "open-whispr");
    seed(path.join(corruptData, "transcriptions.db"), "not a database");
    assert.throws(
      () => run(corrupt),
      (error) =>
        error.status === 1 && error.stderr.includes("Could not read the notes mirror's record")
    );
    assert.deepEqual(fs.readdirSync(corruptData).sort(), [
      "audit",
      "local-data-wipe.pending",
      "transcriptions.db",
    ]);
    assert.equal(recorded(corruptData)[0].reason, "incomplete");
    const journaled = path.join(root, "journaled-home");
    const journaledData = path.join(journaled, "Library", "Application Support", "open-whispr");
    mirrorWrote(journaledData, path.join(journaled, "Vault"), "1-a.md", mirrored(1));
    seed(path.join(journaledData, "transcriptions.db-journal"), "journal");
    assert.throws(
      () => run(journaled),
      (error) =>
        error.status === 1 && error.stderr.includes("Could not read the notes mirror's record")
    );
    assert.equal(exists(journaled, "Vault", "1-a.md"), true);
    assert.equal(exists(journaledData, "transcriptions.db"), true);
    assert.deepEqual(
      recorded(userData).map((line) => line.trigger),
      ["script"]
    );
    // A finished home loses any marker an earlier run left.
    const finished = KEPT_USER_DATA_ENTRIES.filter((name) => name !== "local-data-wipe.pending");
    assert.deepEqual(
      fs.readdirSync(userData).sort(),
      [...finished, ...MODEL_USER_DATA_ENTRIES].sort()
    );
    assert.deepEqual(fs.readdirSync(cache).sort(), [...MODEL_CACHE_ENTRIES].sort());
    assert.deepEqual(fs.readdirSync(path.join(home, ".openwhispr")), ["cli-config.json"]);
    assert.deepEqual(fs.readdirSync(vault).sort(), ["Personal", "Zettel"]);
    assert.deepEqual(fs.readdirSync(path.join(vault, "Personal")), ["15-retro.md"]);
    assert.deepEqual(fs.readdirSync(path.join(vault, "Zettel")), ["202311151230-idea.md"]);
    assert.deepEqual(fs.readdirSync(beside), ["3-plan.md"]);

    // A folder the user replaced with a symlink is not followed out of the home,
    // and the skip fails the device so the MDM tool doesn't show it as wiped.
    const linked = path.join(root, "linked-home");
    const elsewhere = path.join(root, "elsewhere");
    seed(path.join(linked, "Library", "Application Support", "open-whispr", "audio", "1.webm"));
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
    const linkedData = path.join(linked, "Library", "Application Support", "open-whispr");
    assert.deepEqual(fs.readdirSync(linkedData).sort(), ["audit", "local-data-wipe.pending"]);
    assert.equal(recorded(linkedData)[0].reason, "incomplete");

    // A store the user moved elsewhere and left a link in place of: the link
    // goes, and what it led to is reported and kept, as the app does.
    const storeLinked = path.join(root, "store-linked-home");
    const storeLinkedData = path.join(storeLinked, "Library", "Application Support", "open-whispr");
    const recordings = path.join(root, "Recordings");
    seed(path.join(recordings, "1.webm"));
    fs.mkdirSync(storeLinkedData, { recursive: true });
    fs.symlinkSync(recordings, path.join(storeLinkedData, "audio"));
    assert.throws(
      () => run(storeLinked),
      (error) =>
        error.status === 1 && error.stderr.includes(`it led to ${recordings}, which wasn't removed`)
    );
    assert.equal(exists(recordings, "1.webm"), true);
    assert.deepEqual(fs.readdirSync(storeLinkedData).sort(), ["audit", "local-data-wipe.pending"]);

    // Run as root, the script never leaves the user's home: a notes folder
    // outside it is reported once and fails the run, and the database still goes.
    const away = path.join(root, "away-home");
    const awayData = path.join(away, "Library", "Application Support", "open-whispr");
    const shared = path.join(root, "Shared");
    mirrorWrote(awayData, shared, "Team/3-plan.md", mirrored(3));
    mirrorWrote(awayData, shared, "Team/4-plan.md", mirrored(4));
    assert.throws(
      () => run(away),
      (error) =>
        error.status === 1 &&
        error.stderr.split(`Skipped ${fs.realpathSync(shared)}: it is outside`).length === 2 &&
        !error.stdout.includes("Removed OpenWhispr local data")
    );
    assert.deepEqual(fs.readdirSync(path.join(shared, "Team")).sort(), ["3-plan.md", "4-plan.md"]);
    assert.deepEqual(fs.readdirSync(awayData).sort(), ["audit", "local-data-wipe.pending"]);
    assert.equal(recorded(awayData)[0].reason, "incomplete");

    // Nor does it go through a folder in a notes folder that the user moved
    // elsewhere, out of it or not, and left a link in place of: reported once,
    // it fails the run, and the database still goes.
    for (const inside of [false, true]) {
      const moved = path.join(root, inside ? "moved-in-home" : "moved-out-home");
      const movedData = path.join(moved, "Library", "Application Support", "open-whispr");
      const movedVault = path.join(moved, "Vault");
      for (const [relPath, id] of [
        ["Kept/1-a.md", 1],
        ["Moved/2-b.md", 2],
        ["Moved/3-c.md", 3],
      ])
        mirrorWrote(movedData, movedVault, relPath, mirrored(id));
      const destination = inside ? path.join(movedVault, "Other") : path.join(moved, "Elsewhere");
      fs.renameSync(path.join(movedVault, "Moved"), destination);
      fs.symlinkSync(destination, path.join(movedVault, "Moved"));
      const skipped = `Skipped ${path.join(fs.realpathSync(movedVault), "Moved")}: it is reached through a link, so its notes weren't removed`;
      assert.throws(
        () => run(moved),
        (error) =>
          error.status === 1 &&
          error.stderr.split(skipped).length === 2 &&
          !error.stdout.includes("Removed OpenWhispr local data")
      );
      assert.equal(exists(movedVault, "Kept"), false);
      assert.deepEqual(fs.readdirSync(destination).sort(), ["2-b.md", "3-c.md"]);
      assert.deepEqual(fs.readdirSync(movedData).sort(), ["audit", "local-data-wipe.pending"]);
      assert.equal(recorded(movedData)[0].reason, "incomplete");
    }

    // A folder it can't empty is reported, the rest still goes, and the exit
    // code tells the MDM tool the device failed. (Root ignores the mode.)
    if (process.getuid() !== 0) {
      const stuck = path.join(root, "stuck-home");
      const stuckData = path.join(stuck, "Library", "Application Support", "open-whispr");
      seed(path.join(stuckData, "audio", "1.webm"));
      seed(path.join(stuckData, "logs", "debug.log"));
      fs.chmodSync(path.join(stuckData, "audio"), 0o555);
      try {
        assert.throws(
          () => run(stuck),
          (error) => error.status === 1
        );
        // Marked, so the app finishes the wipe before it opens there.
        assert.deepEqual(fs.readdirSync(stuckData).sort(), [
          "audio",
          "audit",
          "local-data-wipe.pending",
        ]);
        assert.equal(recorded(stuckData)[0].reason, "incomplete");
      } finally {
        fs.chmodSync(path.join(stuckData, "audio"), 0o755);
      }
    }

    // As a Jamf Pro policy calls it: target volume, computer name and user
    // first, then its parameters, the blank ones empty.
    run("/", "Jo's MacBook", "jo", "--include-models", home, "", "");
    assert.deepEqual(fs.readdirSync(userData).sort(), [...finished].sort());
    assert.deepEqual(fs.readdirSync(cache), []);
  }
);

test(
  "the macOS script quits only its home's owner's app, keeps only the audit files in an AuditLogPath it empties, and keeps the database while a note can't be read",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "open-whispr");
    // The logs folder itself: its debug logs still go.
    const auditLogPath = path.join(userData, "logs");
    seed(path.join(userData, "logs", "debug.log"));
    seed(path.join(auditLogPath, "meeting-audit-it-2026-11-01.jsonl"), "{}\n");
    const vault = path.join(home, "Documents", "Vault");
    mirrorWrote(userData, vault, "Personal/1-a.md", mirrored(1));
    const note = path.join(vault, "Personal", "1-a.md");
    const calls = path.join(root, "process-lookups.log");
    // A Mac's disk ignores case, so IT may type the folder in another one.
    const typed = process.platform === "darwin" ? path.join(userData, "LOGS") : auditLogPath;
    const run = macosScript({
      pgrep: `echo "$*" >> "${calls}"\nexit 1`,
      // AuditLogPath deployed device-wide.
      defaults: `[ "$2" = "/Library/Managed Preferences/com.gizmolabs.openwhispr" ] && [ "$3" = AuditLogPath ] && echo "${typed}" && exit 0\nexit 1`,
    });
    const wipeLines = () =>
      fs
        .readdirSync(auditLogPath)
        .filter((name) => name !== "meeting-audit-it-2026-11-01.jsonl")
        .flatMap((name) =>
          fs.readFileSync(path.join(auditLogPath, name), "utf8").trim().split("\n")
        )
        .map((line) => JSON.parse(line));
    fs.chmodSync(note, 0o000);
    try {
      assert.throws(
        () => run(home),
        (error) => error.status === 1 && error.stderr.includes("Could not read")
      );
      assert.equal(fs.existsSync(note), true);
      // Running it again needs the record of what the mirror wrote, and the
      // marker has the app finish first if it opens before then.
      assert.equal(exists(userData, "transcriptions.db"), true);
      assert.equal(exists(userData, "local-data-wipe.pending"), true);
      assert.equal(exists(userData, "logs", "debug.log"), false);
      assert.ok(fs.readdirSync(auditLogPath).includes("meeting-audit-it-2026-11-01.jsonl"));
      assert.deepEqual(
        wipeLines().map((line) => [line.trigger, line.reason]),
        [["script", "incomplete"]]
      );
      assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), [
        `-U ${process.getuid()} -f OpenWhispr.app/Contents/`,
      ]);

      fs.chmodSync(note, 0o644);
      run(home);
      assert.equal(fs.existsSync(note), false);
      assert.equal(exists(userData, "transcriptions.db"), false);
      assert.equal(exists(userData, "local-data-wipe.pending"), false);
      assert.deepEqual(
        wipeLines().map((line) => line.reason),
        ["incomplete", null]
      );
    } finally {
      if (fs.existsSync(note)) fs.chmodSync(note, 0o644);
    }
  }
);

// A user may pick their home itself as the notes folder.
test(
  "the macOS script cleans a notes folder that is the home itself",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "open-whispr");
    mirrorWrote(userData, home, "Personal/1-a.md", mirrored(1));
    assert.match(macosScript()(home), /Removed/);
    assert.equal(exists(home, "Personal"), false);
    assert.equal(exists(userData, "transcriptions.db"), false);
  }
);

// A sparse file takes no room, but reading one would hold the run for days.
test(
  "the macOS script keeps the database when a note is too large to read",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const home = path.join(root, "home");
    const userData = path.join(home, "Library", "Application Support", "open-whispr");
    const vault = path.join(home, "Documents", "Vault");
    mirrorWrote(userData, vault, "Personal/1-a.md", mirrored(1));
    fs.truncateSync(path.join(vault, "Personal", "1-a.md"), (512 << 20) + 1);
    assert.throws(
      () => macosScript()(home),
      (error) => error.status === 1 && error.stderr.includes("Could not read")
    );
    assert.equal(exists(vault, "Personal", "1-a.md"), true);
    assert.equal(exists(userData, "transcriptions.db"), true);
  }
);

// A copy is a leftover only once the run that made it has ended: a run still
// reading it would write, as root, through whatever a user put in its place.
test(
  "the macOS script removes only copies left by runs that have ended",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async (t) => {
    const { spawnSync } = require("node:child_process");
    const ended = spawnSync("true").pid;
    const running = fs.mkdtempSync(`/tmp/openwhispr-wipe.${process.pid}.`);
    const left = fs.mkdtempSync(`/tmp/openwhispr-wipe.${ended}.`);
    t.after(() => fs.rmSync(running, { recursive: true, force: true }));
    t.after(() => fs.rmSync(left, { recursive: true, force: true }));
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    macosScript()(home);
    assert.equal(fs.existsSync(running), true);
    assert.equal(fs.existsSync(left), false);
  }
);
