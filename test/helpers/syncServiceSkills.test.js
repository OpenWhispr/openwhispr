// The skills half of SyncService: the real service, over a real SkillLibrary and
// DatabaseManager, with only the HTTP boundary faked.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SkillLibrary } = require("../../src/helpers/skills/skillLibrary");
const { SyncService } = require("../../src/services/SyncService.ts");
const { RECOMMENDED_DIR, skillText, writeFolder, listDir } = require("./skills/libraryFixture");

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-skill-sync-pass-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const library = new SkillLibrary({ userDataDir, database: db, recommendedDir: RECOMMENDED_DIR });
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud, skillLibrary: library });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, library, cloud, api, service, skillsDir: path.join(userDataDir, "skills") };
}

const create = (library, title) =>
  library.create({ title, description: `About ${title}.`, instructions: "Steps.", files: [] })
    .name;
const pendingNames = (db) => db.getPendingSkills().map((row) => row.name);
const cloudByName = (cloud) => Object.fromEntries(cloud.skills().map((row) => [row.name, row]));
const sentNames = (cloud) =>
  cloud
    .logFor("/api/skills/batch-create")
    .map((call) => call.body.entries.map((entry) => entry.name));
const silence = (t, method = "error") => t.mock.method(console, method, () => {});
const messages = (mock) =>
  mock.mock.calls.map((call) => call.arguments.map((a) => String(a?.message ?? a)).join(" "));

test("skills sync after snippets only with Cloud backup consent", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");

  localStorageStub.setItem("cloudBackupEnabled", "false");
  await ctx.service.syncAll(true);
  assert.equal(ctx.cloud.log.filter((call) => call.path.startsWith("/api/skills")).length, 0);
  assert.deepEqual(pendingNames(ctx.db), [name]);

  localStorageStub.setItem("cloudBackupEnabled", "true");
  await ctx.service.syncAll(true);

  const paths = ctx.cloud.log.map((call) => call.path.split("?")[0]);
  assert.ok(
    paths.indexOf("/api/skills/batch-create") > paths.lastIndexOf("/api/snippets/list"),
    "skills go after snippets"
  );
  const stored = cloudByName(ctx.cloud)[name];
  assert.equal(stored.enabled, true);
  assert.deepEqual(
    stored.files.map((file) => file.path),
    ["SKILL.md"]
  );
  assert.equal(stored.content_hash, ctx.db.getSkillStates()[0].contentHash);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a missing skills binding aborts the pass like snippets", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const errors = silence(t);
  create(ctx.library, "Meeting prep");

  delete windowStub.electronAPI.applySkillFromCloud;
  await ctx.service.syncAll(true);

  assert.equal(ctx.cloud.logFor("/api/skills/batch-create").length, 0);
  assert.equal(localStorageStub.getItem("lastSyncedAt"), null);
  assert.ok(messages(errors).some((m) => m.includes("applySkillFromCloud")));
});

test("batches carry at most 10 skills and 3 MB", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  for (let index = 0; index < 12; index += 1) create(ctx.library, `Small ${index}`);
  for (const name of ["big-a", "big-b", "big-c", "big-d"]) {
    writeFolder(ctx.skillsDir, name, {
      "SKILL.md": skillText(name),
      "references/big.md": "x".repeat(900_000),
    });
  }

  await ctx.service.syncSkillsNow();

  const batches = sentNames(ctx.cloud);
  assert.ok(batches.every((names) => names.length <= 10));
  for (const call of ctx.cloud.logFor("/api/skills/batch-create")) {
    assert.ok(Buffer.byteLength(JSON.stringify(call.body.entries)) <= 3 * 1024 * 1024);
  }
  assert.equal(batches.flat().length, 16);
  assert.equal(ctx.cloud.skills().length, 16);
});

test("a skill over the sync caps is never pushed and stays on this computer", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "too-big", {
    "SKILL.md": skillText("too-big"),
    "references/big.md": "x".repeat(1024 * 1024),
  });
  create(ctx.library, "Small one");

  await ctx.service.syncSkillsNow();

  assert.deepEqual(Object.keys(cloudByName(ctx.cloud)), ["small-one"]);
  assert.deepEqual(listDir(ctx.skillsDir), ["small-one", "too-big"]);
});

test("enabled state travels both ways", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();

  ctx.library.setEnabled(name, false);
  await ctx.service.syncSkillsNow();
  assert.equal(cloudByName(ctx.cloud)[name].enabled, false);
  assert.deepEqual(pendingNames(ctx.db), []);

  const stored = cloudByName(ctx.cloud)[name];
  // Switched back on from another device, a moment later.
  const later = new Date(Date.parse(stored.updated_at) + 1000).toISOString();
  ctx.cloud.setClock(() => later);
  ctx.cloud.seedSkill({ ...stored, enabled: true });
  await ctx.service.syncSkillsNow();
  assert.equal(ctx.library.scan()[0].enabled, true);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a skill from another device appears here, and its delete removes it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const seeded = ctx.cloud.seedSkill({
    client_skill_id: "other-device",
    name: "weekly-recap",
    enabled: true,
    content_hash: "h",
    files: [{ path: "SKILL.md", encoding: "utf8", content: skillText("weekly-recap") }],
  });

  await ctx.service.syncSkillsNow();
  assert.deepEqual(
    ctx.library.scan().map((skill) => [skill.name, skill.enabled, skill.valid]),
    [["weekly-recap", true, true]]
  );
  assert.ok(ctx.api.syncEvents.some((event) => event.name === "skills-changed"));

  // A later millisecond than the create: the delta's keyset skips a row it already pulled at
  // the same time and id.
  ctx.cloud.setClock(() => new Date(Date.now() + 1000).toISOString());
  ctx.cloud.deleteSkill(seeded.id);
  await ctx.service.syncSkillsNow();
  assert.deepEqual(listDir(ctx.skillsDir), []);
  assert.deepEqual(ctx.library.scan(), []);
  assert.equal(ctx.cloud.logFor("/api/skills/delete").length, 0, "the delete isn't echoed back");
});

test("uninstalling a synced skill deletes it in the cloud, then forgets it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();

  ctx.library.uninstall(name);
  await ctx.service.syncSkillsNow();

  assert.ok(cloudByName(ctx.cloud)[name].deleted_at);
  assert.deepEqual(ctx.db.getPendingSkillDeletes(), []);
  assert.equal(
    ctx.db.db.prepare("SELECT COUNT(*) AS count FROM skills").get().count,
    0,
    "the tombstone is gone once the delete is pushed"
  );
});

test("a 409 stops the retry and a 404 clears cloud_id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t);
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();
  const cloudId = cloudByName(ctx.cloud)[name].id;

  ctx.library.setEnabled(name, false);
  ctx.cloud.failNext("PATCH /api/skills/update", { status: 409 });
  await ctx.service.syncSkillsNow();
  assert.deepEqual(pendingNames(ctx.db), [], "a refused update isn't sent again and again");

  ctx.library.setEnabled(name, true);
  ctx.cloud.failNext("PATCH /api/skills/update", { status: 404 });
  await ctx.service.syncSkillsNow();
  const row = ctx.db.getSkillForCloudMerge({ name });
  assert.deepEqual([row.cloud_id, row.sync_status], [null, "pending"]);

  await ctx.service.syncSkillsNow();
  assert.equal(ctx.db.getSkillForCloudMerge({ name }).cloud_id, cloudId, "re-created by name");
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("an older API without /api/skills (404 on list) is skipped without error", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const errors = silence(t);
  create(ctx.library, "Meeting prep");
  ctx.cloud.failWith("/api/skills/list", { status: 404 });
  ctx.cloud.failWith("/api/skills/batch-create", { status: 404 });

  await ctx.service.syncAll(true);

  assert.ok(localStorageStub.getItem("lastSyncedAt"), "the pass completes");
  assert.deepEqual(
    messages(errors).filter((m) => /skill/i.test(m)),
    []
  );
  assert.equal(localStorageStub.getItem("lastSyncedAt.skills"), null);
});

// Runs `during` once, while the first request matching `route` is with the server.
function whileSending(ctx, route, during) {
  const send = ctx.api.cloudApiRequest;
  let done = false;
  ctx.api.cloudApiRequest = async (opts) => {
    if (!done && `${opts.method} ${opts.path}`.startsWith(route)) {
      done = true;
      await during();
    }
    return send(opts);
  };
}

const skillFile = (skillsDir, name) =>
  fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
const cloudSkillMd = (name, body) => [
  { path: "SKILL.md", encoding: "utf8", content: skillText(name, "Does it.", body) },
];
// A skill saved on another device, as the cloud holds it.
const seedRemote = (ctx, name, body, enabled = true) =>
  ctx.cloud.seedSkill({ name, enabled, content_hash: "h", files: cloudSkillMd(name, body) });

test("uninstalling a skill while its first push is in flight doesn't bring it back", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  whileSending(ctx, "POST /api/skills/batch-create", () => ctx.library.uninstall(name));

  await ctx.service.syncSkillsNow();
  await ctx.service.syncSkillsNow();

  assert.deepEqual(listDir(ctx.skillsDir), []);
  assert.ok(cloudByName(ctx.cloud)[name].deleted_at, "the copy that got through is deleted");
});

test("a first push doesn't overwrite a newer copy from another device", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "recap", { "SKILL.md": skillText("recap", "Does it.", "Old.\n") });
  ctx.library.scan();
  ctx.cloud.setClock(() => new Date(Date.now() + 60_000).toISOString());
  seedRemote(ctx, "recap", "Newer.\n");

  await ctx.service.syncSkillsNow();

  assert.equal(skillFile(ctx.skillsDir, "recap"), skillText("recap", "Does it.", "Newer.\n"));
  assert.match(cloudByName(ctx.cloud).recap.files[0].content, /Newer\./);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a first push does overwrite an older copy from another device", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  ctx.cloud.setClock(() => "2026-01-01T09:00:00.000Z");
  seedRemote(ctx, "recap", "Old.\n");
  ctx.cloud.setClock(() => new Date().toISOString());
  writeFolder(ctx.skillsDir, "recap", { "SKILL.md": skillText("recap", "Does it.", "Mine.\n") });
  ctx.library.scan();

  await ctx.service.syncSkillsNow();

  assert.match(cloudByName(ctx.cloud).recap.files[0].content, /Mine\./);
  assert.equal(skillFile(ctx.skillsDir, "recap"), skillText("recap", "Does it.", "Mine.\n"));
});

test("an edit made while its push is in flight is kept and sent next", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();
  const edit = (body) => {
    writeFolder(ctx.skillsDir, name, { "SKILL.md": skillText(name, "Use it.", body) });
    ctx.library.scan();
  };
  edit("First edit.\n");
  whileSending(ctx, "PATCH /api/skills/update", () => edit("Latest edit.\n"));

  await ctx.service.syncSkillsNow();
  assert.equal(skillFile(ctx.skillsDir, name), skillText(name, "Use it.", "Latest edit.\n"));
  assert.deepEqual(pendingNames(ctx.db), [name]);

  await ctx.service.syncSkillsNow();
  assert.match(cloudByName(ctx.cloud)[name].files[0].content, /Latest edit\./);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a skill too large to back up is never replaced from the cloud", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "big-one", {
    "SKILL.md": skillText("big-one"),
    "references/big.md": "x".repeat(1024 * 1024),
  });
  ctx.library.scan();
  ctx.cloud.setClock(() => new Date(Date.now() + 60_000).toISOString());
  seedRemote(ctx, "big-one", "Small.\n", false);

  await ctx.service.syncSkillsNow();

  assert.deepEqual(listDir(path.join(ctx.skillsDir, "big-one", "references")), ["big.md"]);
});

test("one skill that can't be written doesn't stop the others, and is tried again", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t);
  for (const name of ["first-one", "second-one"]) {
    seedRemote(ctx, name, "Hi.\n");
  }
  const apply = ctx.api.applySkillFromCloud;
  let failOnce = true;
  ctx.api.applySkillFromCloud = async (entry) => {
    if (entry.name === "first-one" && failOnce) {
      failOnce = false;
      throw Object.assign(new Error("Couldn't write the skill: EBUSY"), { code: "unknown" });
    }
    return apply(entry);
  };

  await ctx.service.syncSkillsNow();
  assert.deepEqual(listDir(ctx.skillsDir), ["second-one"]);

  await ctx.service.syncSkillsNow();
  assert.deepEqual(listDir(ctx.skillsDir), ["first-one", "second-one"]);
});

test("an edit made while a skill's first push is in flight is kept and sent next", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  whileSending(ctx, "POST /api/skills/batch-create", () => {
    writeFolder(ctx.skillsDir, name, { "SKILL.md": skillText(name, "Use it.", "Edited.\n") });
    ctx.library.scan();
    // The server stamps the create after the edit, as when the edit lands mid-request.
    ctx.cloud.setClock(() => new Date(Date.now() + 60_000).toISOString());
  });

  await ctx.service.syncSkillsNow();
  await ctx.service.syncSkillsNow();

  assert.equal(skillFile(ctx.skillsDir, name), skillText(name, "Use it.", "Edited.\n"));
  assert.match(cloudByName(ctx.cloud)[name].files[0].content, /Edited\./);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a pull that fails sends no skill this computer has never sent", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t);
  writeFolder(ctx.skillsDir, "recap", { "SKILL.md": skillText("recap", "Does it.", "Old.\n") });
  ctx.library.scan();
  ctx.cloud.setClock(() => new Date(Date.now() + 60_000).toISOString());
  seedRemote(ctx, "recap", "Newer.\n");
  ctx.cloud.failNext("/api/skills/list", { status: 500 });

  await ctx.service.syncSkillsNow();
  assert.match(cloudByName(ctx.cloud).recap.files[0].content, /Newer\./);

  await ctx.service.syncSkillsNow();
  assert.equal(skillFile(ctx.skillsDir, "recap"), skillText("recap", "Does it.", "Newer.\n"));
});

test("a skill the library fails to write is held back and tried again", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t);
  silence(t, "warn");
  for (const name of ["first-one", "second-one"]) {
    seedRemote(ctx, name, "Hi.\n");
  }
  const apply = ctx.library.applyFromCloud.bind(ctx.library);
  let failOnce = true;
  ctx.library.applyFromCloud = (entry) => {
    if (entry.name === "first-one" && failOnce) {
      failOnce = false;
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    }
    return apply(entry);
  };

  await ctx.service.syncSkillsNow();
  assert.deepEqual(listDir(ctx.skillsDir), ["second-one"]);

  await ctx.service.syncSkillsNow();
  assert.deepEqual(listDir(ctx.skillsDir), ["first-one", "second-one"]);
});

test("a pull that can't read this computer's copy of a skill leaves it as it is", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t);
  silence(t, "warn");
  writeFolder(ctx.skillsDir, "recap", { "SKILL.md": skillText("recap", "Does it.", "Mine.\n") });
  ctx.library.scan();
  // Older than the copy here, so the cloud's copy only wins if the lookup is taken for "none".
  ctx.cloud.setClock(() => new Date(Date.now() - 60_000).toISOString());
  seedRemote(ctx, "recap", "Theirs.\n");
  const lookup = ctx.db.getSkillForCloudMerge.bind(ctx.db);
  let failOnce = true;
  ctx.db.getSkillForCloudMerge = (entry) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return lookup(entry);
  };

  await ctx.service.syncSkillsNow();
  assert.equal(skillFile(ctx.skillsDir, "recap"), skillText("recap", "Does it.", "Mine.\n"));
  assert.match(cloudByName(ctx.cloud).recap.files[0].content, /Theirs\./, "nothing sent yet");

  await ctx.service.syncSkillsNow();
  assert.equal(skillFile(ctx.skillsDir, "recap"), skillText("recap", "Does it.", "Mine.\n"));
  assert.match(cloudByName(ctx.cloud).recap.files[0].content, /Mine\./);
});

test("an edit made outside the app since the last read wins over a newer cloud copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();
  assert.deepEqual(pendingNames(ctx.db), []);
  // Edited in another editor, with nothing in the app reading the folder since.
  writeFolder(ctx.skillsDir, name, { "SKILL.md": skillText(name, "Use it.", "Mine.\n") });
  ctx.cloud.setClock(() => new Date(Date.now() + 60_000).toISOString());
  seedRemote(ctx, name, "Theirs.\n");

  await ctx.service.syncSkillsNow();

  assert.equal(skillFile(ctx.skillsDir, name), skillText(name, "Use it.", "Mine.\n"));
  assert.match(cloudByName(ctx.cloud)[name].files[0].content, /Mine\./);
});

test("an uninstall mid-push whose mark fails doesn't bring the skill back", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t, "warn");
  const name = create(ctx.library, "Meeting prep");
  whileSending(ctx, "POST /api/skills/batch-create", () => ctx.library.uninstall(name));
  const mark = ctx.db.markSkillSynced.bind(ctx.db);
  let failOnce = true;
  ctx.db.markSkillSynced = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return mark(...args);
  };

  await ctx.service.syncSkillsNow();
  await ctx.service.syncSkillsNow();

  assert.deepEqual(listDir(ctx.skillsDir), []);
  assert.ok(cloudByName(ctx.cloud)[name].deleted_at, "the copy that got through is deleted");
});
