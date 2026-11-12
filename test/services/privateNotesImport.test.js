// The one-time import of an account's cloud private notes: every personal
// folder and note comes into the account's default Private, then the server is
// told the account keeps its private notes on its devices (it purges the cloud
// copies 30 days later). Real DatabaseManager and SyncService on one window;
// only HTTP is faked, with one cloud per account.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("../helpers/harness/syncDevice.js");
const { createAccountCloud } = require("../helpers/harness/fakeCloud.js");
const { localStorage: storage } = require("../helpers/harness/browserGlobals.js");

// Mirrors BATCH_SIZE in SyncService.ts: one note more than this is two pages.
const BATCH_SIZE = 50;
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const STATE_ROUTE = "/api/me/private-notes";
const SWITCH_ROUTE = "/api/me/private-notes/on-device";
const NOTES_LIST = "/api/notes/list";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const markerOf = (accountId) => storage.getItem(`privateNotesOnDevice:${accountId}`);

// The server's clock runs a day behind this device's and ticks on every
// read, so a pulled_through taken from the local clock never matches the
// server_time the state call returned.
function serverClockBehind(cloud) {
  let now = Date.now() - DAY_MS;
  cloud.setClock(() => new Date((now += 1000)).toISOString());
}

// Every answer the cloud gave, beside the request it answered.
function recordAnswers(cloud) {
  const answers = [];
  const request = cloud.request;
  cloud.request = async (opts) => {
    const answer = await request(opts);
    answers.push({ route: routeOf(opts), path: opts.path, answer });
    return answer;
  };
  return answers;
}

const serverTimesOf = (answers) =>
  answers
    .filter((entry) => entry.route === STATE_ROUTE)
    .map((entry) => entry.answer.data.server_time);

// Personal notes written on other devices a while ago, oldest first.
function seedPersonalNotes(cloud, count, { prefix = "cloud-note", ...fields } = {}) {
  const start = Date.now() - 30 * DAY_MS;
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(start + index * 60_000).toISOString();
    return cloud.seedNote({
      client_note_id: `${prefix}-${index}`,
      title: `${prefix} ${index}`,
      content: `Written elsewhere ${index}`,
      created_at: at,
      updated_at: at,
      ...fields,
    });
  });
}

function liveNotes(db) {
  return db.db.prepare("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY id").all();
}

const rowOf = (db, table, id) => db.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

// Another account's Private on this device.
function privateSpaceOf(db, accountId) {
  return Number(
    db.db
      .prepare(
        `INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status, account_id, workspace_id)
         VALUES (?, 'private', 'Personal', 0, 'synced', ?, NULL)`
      )
      .run(`private-${accountId}`, accountId).lastInsertRowid
  );
}

// Runs `change` once, right after the nth call of the device's `method`
// returns (or before it starts, with { before: true }).
function onCall(device, method, nth, change, { before = false } = {}) {
  const original = device.api[method];
  let calls = 0;
  device.api[method] = async (...args) => {
    calls += 1;
    if (before && calls === nth) await change();
    const result = await original(...args);
    if (!before && calls === nth) await change();
    return result;
  };
}

// A device signed in as account A against an API that has the routes.
async function signedInDevice(t, cloudConfig = {}) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud({ privateNotesRoutes: true, ...cloudConfig });
  serverClockBehind(cloud);
  await device.signIn(ACCOUNT_A, cloud);
  return { device, cloud };
}

test("imports every personal note into the default Private and switches", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const answers = recordAnswers(cloud);
  const seeded = seedPersonalNotes(cloud, BATCH_SIZE + 1);
  // The regular passes' delta cursors: the import reads and moves neither.
  const cursor = "2026-11-01T00:00:00.000Z";
  storage.setItem("lastSyncedAt.notes", cursor);
  storage.setItem("lastSyncedAt.folders", cursor);

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  const imported = liveNotes(device.db);
  assert.deepEqual(
    imported.map((note) => note.client_note_id).sort(),
    seeded.map((note) => note.client_note_id).sort()
  );
  for (const note of imported) {
    assert.equal(note.space_id, defaultPrivate);
    assert.equal(note.account_id, ACCOUNT_A);
  }
  const noteLists = answers.filter((entry) => entry.route === NOTES_LIST);
  assert.equal(noteLists.length, 2, "the notes came in two pages");
  assert.ok(
    noteLists.every((entry) => !/[?&]since=/.test(entry.path)),
    "the import pulls with no cursor"
  );

  const switches = cloud.logFor(SWITCH_ROUTE);
  assert.equal(switches.length, 1);
  assert.deepEqual(switches[0].body, { pulled_through: serverTimesOf(answers)[0] });
  const state = cloud.privateNotesState();
  assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), state);
  assert.deepEqual(
    device.api.syncEvents.filter((event) => event.name === "private-notes-on-device"),
    [{ name: "private-notes-on-device", payload: { purgeAfter: state.purge_after } }]
  );
  assert.equal(storage.getItem("lastSyncedAt.notes"), cursor);
  assert.equal(storage.getItem("lastSyncedAt.folders"), cursor);
});

test("retries when the server says notes changed", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const answers = recordAnswers(cloud);
  const [edited] = seedPersonalNotes(cloud, 3);
  // Another device edits a note between this device's pull and its switch.
  let editedElsewhere = false;
  device.hooks.beforeRequest = async (call) => {
    if (editedElsewhere || routeOf(call) !== SWITCH_ROUTE) return;
    editedElsewhere = true;
    await cloud.request({
      method: "PATCH",
      path: "/api/notes/update",
      body: { id: edited.id, content: "Edited on another device" },
    });
  };

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const switchAnswers = answers.filter((entry) => entry.route === SWITCH_ROUTE);
  assert.deepEqual(
    switchAnswers.map((entry) => entry.answer.code ?? "ok"),
    ["personal_notes_changed", "ok"]
  );
  const serverTimes = serverTimesOf(answers);
  assert.equal(serverTimes.length, 2, "a fresh server_time for the second try");
  assert.deepEqual(
    cloud.logFor(SWITCH_ROUTE).map((call) => call.body.pulled_through),
    serverTimes
  );
  assert.equal(
    answers.filter((entry) => entry.route === NOTES_LIST).length,
    2,
    "the notes were pulled again"
  );
  assert.equal(
    device.db.getNoteByClientId(edited.client_note_id).content,
    "Edited on another device"
  );
});

test("gives up after three retries while the notes keep changing", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);
  cloud.failWith((call) => routeOf(call) === SWITCH_ROUTE, {
    status: 409,
    code: "personal_notes_changed",
  });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 4, "the first try and three retries");
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.deepEqual(device.api.syncEvents, []);
});

test("a network failure mid-import switches nothing and runs again next time", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const seeded = seedPersonalNotes(cloud, BATCH_SIZE + 1);
  cloud.failNext((call) => routeOf(call) === NOTES_LIST && call.path.includes("before="), {
    status: 503,
  });
  // The pull logs the failed page.
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");
  assert.equal(liveNotes(device.db).length, BATCH_SIZE, "the first page arrived");
  assert.deepEqual(cloud.logFor(SWITCH_ROUTE), []);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.equal(cloud.privateNotesState(), null);

  // The next pass after the wait a failure starts.
  t.mock.timers.tick(5 * MINUTE_MS);
  await device.service.syncAll(true);

  assert.deepEqual(
    liveNotes(device.db)
      .map((note) => note.client_note_id)
      .sort(),
    seeded.map((note) => note.client_note_id).sort()
  );
  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1);
  assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
});

test("an account already switched skips the import", async (t) => {
  await t.test("switched on this device: nothing is asked of the cloud", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    seedPersonalNotes(cloud, 2);
    storage.setItem(
      `privateNotesOnDevice:${ACCOUNT_A}`,
      JSON.stringify({
        on_device_since: "2026-11-01T00:00:00.000Z",
        purge_after: "2026-12-01T00:00:00.000Z",
      })
    );

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "already");
    assert.deepEqual(cloud.log, []);
    assert.deepEqual(liveNotes(device.db), []);
  });

  await t.test("switched from another device: the state is kept, nothing pulled", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    seedPersonalNotes(cloud, 2);
    cloud.switchOnDevice();

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "already");
    assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
    assert.deepEqual(cloud.logFor(NOTES_LIST), []);
    assert.deepEqual(cloud.logFor(SWITCH_ROUTE), []);
    assert.deepEqual(liveNotes(device.db), []);
    assert.deepEqual(device.api.syncEvents, []);
  });

  await t.test("storage it can't read: the server is asked", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    cloud.switchOnDevice();
    const getItem = storage.getItem;
    storage.getItem = (key) => {
      if (String(key).startsWith("privateNotesOnDevice:")) throw new Error("storage unavailable");
      return getItem.call(storage, key);
    };
    st.after(() => {
      storage.getItem = getItem;
    });

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "already");
    assert.equal(cloud.logFor(STATE_ROUTE).length, 1);
    assert.deepEqual(cloud.logFor(NOTES_LIST), []);
  });
});

test("runs with Backup off", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const seeded = seedPersonalNotes(cloud, 3);
  storage.setItem("cloudBackupEnabled", "false");

  await device.service.syncAll(true);

  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  assert.deepEqual(
    liveNotes(device.db)
      .filter((note) => note.space_id === defaultPrivate)
      .map((note) => note.client_note_id)
      .sort(),
    seeded.map((note) => note.client_note_id).sort()
  );
  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1);
  assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
});

test("an account switch mid-import writes nothing more and switches nothing", async (t) => {
  // Page 1 is written, then the user switches to B: before page 2 is asked
  // for, or once it arrived, as its first row is looked up.
  for (const [when, method] of [
    ["between the pages", "upsertNoteFromCloud"],
    ["while page 2 is written", "getNoteForCloudRow"],
  ]) {
    await t.test(when, async (st) => {
      const setup = await signedInDevice(st);
      if (!setup) return;
      const { device, cloud: cloudA } = setup;
      const cloudB = createAccountCloud({ privateNotesRoutes: true });
      seedPersonalNotes(cloudB, 1, { prefix: "b-note" });
      const seeded = seedPersonalNotes(cloudA, BATCH_SIZE + 1);
      // Snapshot pages walk created_at backwards: the oldest note is page 2.
      const pageTwo = seeded[0];
      let requestsBefore = null;
      const switchToB = async () => {
        device.signOut();
        await device.signIn(ACCOUNT_B, cloudB);
        requestsBefore = cloudA.log.length;
      };
      if (method === "upsertNoteFromCloud") onCall(device, method, BATCH_SIZE, switchToB);
      else onCall(device, method, BATCH_SIZE + 1, switchToB, { before: true });

      assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

      const written = device.db.db.prepare("SELECT client_note_id, account_id FROM notes").all();
      assert.equal(written.length, BATCH_SIZE, "page 1 only");
      assert.ok(written.every((row) => row.account_id === ACCOUNT_A));
      assert.ok(!written.some((row) => row.client_note_id === pageTwo.client_note_id));
      assert.deepEqual(cloudB.log, [], "no request went out under B's sign-in");
      assert.equal(cloudA.log.length, requestsBefore, "nor any more under A's");
      assert.deepEqual(cloudA.logFor(SWITCH_ROUTE), []);
      assert.equal(cloudA.privateNotesState(), null);
      assert.equal(markerOf(ACCOUNT_A), null);
      assert.equal(markerOf(ACCOUNT_B), null);
      assert.deepEqual(device.api.syncEvents, []);
    });
  }
});

test("a sign-in change after the last page switches nothing", async (t) => {
  // After the last row is written, or as the switch request goes out.
  for (const [when, method] of [
    ["after the last row is written", "upsertNoteFromCloud"],
    ["as the switch goes out", "cloudApiRequest"],
  ]) {
    await t.test(when, async (st) => {
      const setup = await signedInDevice(st);
      if (!setup) return;
      const { device, cloud: cloudA } = setup;
      const cloudB = createAccountCloud({ privateNotesRoutes: true });
      seedPersonalNotes(cloudA, 1);
      const switchToB = async () => {
        device.signOut();
        await device.signIn(ACCOUNT_B, cloudB);
      };
      if (method === "upsertNoteFromCloud") {
        onCall(device, method, 1, switchToB);
      } else {
        const request = device.api.cloudApiRequest;
        device.api.cloudApiRequest = async (opts) => {
          if (routeOf(opts) === SWITCH_ROUTE) await switchToB();
          return request(opts);
        };
      }

      assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

      assert.deepEqual(cloudA.logFor(SWITCH_ROUTE), []);
      assert.deepEqual(cloudB.log, []);
      assert.equal(cloudA.privateNotesState(), null);
      assert.equal(cloudB.privateNotesState(), null);
      assert.equal(markerOf(ACCOUNT_A), null);
      assert.equal(markerOf(ACCOUNT_B), null);
      assert.deepEqual(device.api.syncEvents, []);
    });
  }
});

test("a note deleted locally while its DELETE is still pending is not re-imported", async (t) => {
  await t.test("the cloud refuses the DELETE for now", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    const [deleted, kept] = seedPersonalNotes(cloud, 2);
    const local = device.db.upsertNoteFromCloud(deleted, null);
    device.db.deleteNote(local.id);
    cloud.failWith("DELETE /api/notes/delete", { status: 503 });
    // The delete push logs the refusal.
    st.mock.method(console, "error", () => {});

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

    assert.deepEqual(
      liveNotes(device.db).map((note) => note.client_note_id),
      [kept.client_note_id]
    );
    assert.ok(
      device.db.getNoteByClientId(deleted.client_note_id)?.deleted_at,
      "the tombstone stays, so its DELETE is sent again"
    );
  });

  await t.test("its DELETE goes out before the import pulls", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    const [deleted, kept] = seedPersonalNotes(cloud, 2);
    const local = device.db.upsertNoteFromCloud(deleted, null);
    device.db.deleteNote(local.id);

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

    assert.ok(cloud.note(deleted.id).deleted_at, "the delete reached the cloud");
    assert.deepEqual(
      liveNotes(device.db).map((note) => note.client_note_id),
      [kept.client_note_id]
    );
    assert.equal(device.db.getNoteByClientId(deleted.client_note_id), null);
    assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
  });
});

test("a note already on this device keeps its space and folder", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  // A Cloud Backup copy filed in another workspace's Private, in a folder there.
  const otherPrivate = device.db.getPrivateSpaceId("workspace-other");
  const { folder } = device.db.createFolder("Projects", otherPrivate);
  const [note] = seedPersonalNotes(cloud, 1);
  device.db.upsertNoteFromCloud(
    {
      ...note,
      content: "Backed up earlier",
      updated_at: new Date(Date.parse(note.updated_at) - DAY_MS).toISOString(),
    },
    folder.id,
    otherPrivate
  );
  assert.notEqual(otherPrivate, device.db.getDefaultPrivateSpaceId());

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const local = device.db.getNoteByClientId(note.client_note_id);
  assert.equal(local.content, note.content, "the newer cloud copy applied");
  assert.equal(local.space_id, otherPrivate);
  assert.equal(local.folder_id, folder.id);
  assert.equal(liveNotes(device.db).length, 1);
});

test("the cloud's Personal and Meetings folders merge into the default Private's own", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  device.db.ensureDefaultFolders(defaultPrivate);
  const localFolders = Object.fromEntries(
    device.db.getFolders(defaultPrivate).map((folder) => [folder.name, folder.id])
  );
  assert.deepEqual(Object.keys(localFolders).sort(), ["Meetings", "Personal"]);
  const cloudPersonal = cloud.seedFolder({
    name: "Personal",
    is_default: true,
    sort_order: 0,
    client_folder_id: "cloud-personal",
  });
  const cloudMeetings = cloud.seedFolder({
    name: "Meetings",
    is_default: true,
    sort_order: 1,
    client_folder_id: "cloud-meetings",
  });
  const [inPersonal] = seedPersonalNotes(cloud, 1, {
    prefix: "personal-note",
    folder_id: cloudPersonal.id,
  });
  const [inMeetings] = seedPersonalNotes(cloud, 1, {
    prefix: "meeting-note",
    folder_id: cloudMeetings.id,
  });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const folders = device.db.getFolders(defaultPrivate);
  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.name, folder.cloud_id]).sort(),
    [
      [localFolders.Meetings, "Meetings", cloudMeetings.id],
      [localFolders.Personal, "Personal", cloudPersonal.id],
    ].sort(),
    "no duplicate folders: each local default adopted its cloud folder"
  );
  assert.equal(
    device.db.getNoteByClientId(inPersonal.client_note_id).folder_id,
    localFolders.Personal
  );
  assert.equal(
    device.db.getNoteByClientId(inMeetings.client_note_id).folder_id,
    localFolders.Meetings
  );
});

test("a second call while an import runs joins it", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);

  const first = device.service.importCloudPrivateNotes(ACCOUNT_A);
  const second = device.service.importCloudPrivateNotes(ACCOUNT_A);

  assert.deepEqual(await Promise.all([first, second]), ["switched", "switched"]);
  assert.equal(cloud.logFor(STATE_ROUTE).length, 1);
  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1);
});

test("an API without the routes fails quietly", async (t) => {
  const setup = await signedInDevice(t, { privateNotesRoutes: false });
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);
  const errors = t.mock.method(console, "error", () => {});

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  assert.deepEqual(cloud.logFor(NOTES_LIST), []);
  assert.deepEqual(liveNotes(device.db), []);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.deepEqual(device.api.syncEvents, []);
  assert.equal(errors.mock.callCount(), 0);
  // No wait follows: the next pass asks again.
  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");
  assert.equal(cloud.logFor(STATE_ROUTE).length, 2);
});

test("a cloud note whose key a note it can't use holds here comes in under a key of its own", async (t) => {
  await t.test("another account's note holds the key", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    const [note] = seedPersonalNotes(cloud, 1);
    // B's note on this device, under the same key, bound to B's own cloud row.
    const bNote = device.db.upsertNoteFromCloud(
      { ...note, id: "b-cloud-row", content: "B's copy" },
      null
    );
    device.db.db
      .prepare("UPDATE notes SET account_id = ?, space_id = ?, folder_id = NULL WHERE id = ?")
      .run(ACCOUNT_B, privateSpaceOf(device.db, ACCOUNT_B), bNote.id);
    const bBefore = rowOf(device.db, "notes", bNote.id);

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

    const aNotes = device.db.db.prepare("SELECT * FROM notes WHERE account_id = ?").all(ACCOUNT_A);
    assert.equal(aNotes.length, 1);
    assert.notEqual(aNotes[0].client_note_id, note.client_note_id, "a key of its own");
    assert.equal(aNotes[0].cloud_id, note.id, "bound to its cloud row");
    assert.equal(aNotes[0].content, note.content);
    assert.equal(aNotes[0].space_id, device.db.getDefaultPrivateSpaceId());
    assert.deepEqual(rowOf(device.db, "notes", bNote.id), bBefore, "B's note is untouched");
  });

  await t.test("its own note bound to another cloud row holds the key", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    const [note] = seedPersonalNotes(cloud, 1);
    const other = device.db.upsertNoteFromCloud(
      { ...note, id: "another-cloud-row", content: "Another copy" },
      null
    );
    const otherBefore = rowOf(device.db, "notes", other.id);

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

    const imported = device.db.db.prepare("SELECT * FROM notes WHERE cloud_id = ?").all(note.id);
    assert.equal(imported.length, 1);
    assert.notEqual(imported[0].client_note_id, note.client_note_id);
    assert.equal(imported[0].content, note.content);
    assert.equal(imported[0].space_id, device.db.getDefaultPrivateSpaceId());
    assert.deepEqual(rowOf(device.db, "notes", other.id), otherBefore);
  });
});

test("a cloud note main stores nothing for fails the import", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const [refused] = seedPersonalNotes(cloud, 2);
  const upsert = device.api.upsertNoteFromCloud;
  device.api.upsertNoteFromCloud = async (cloudNote, ...rest) =>
    cloudNote.id === refused.id ? null : upsert(cloudNote, ...rest);
  t.mock.method(console, "warn", () => {});

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  assert.deepEqual(cloud.logFor(SWITCH_ROUTE), []);
  assert.equal(cloud.privateNotesState(), null);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.deepEqual(device.api.syncEvents, []);
});

test("a cloud folder whose key another account's folder holds here never takes it over", async (t) => {
  for (const [when, sameNamed] of [
    ["with no folder of that name here", false],
    ["with a folder of that name to merge into", true],
  ]) {
    await t.test(when, async (st) => {
      const setup = await signedInDevice(st);
      if (!setup) return;
      const { device, cloud } = setup;
      const defaultPrivate = device.db.getDefaultPrivateSpaceId();
      const bFolderId = Number(
        device.db.db
          .prepare(
            `INSERT INTO folders (name, sort_order, client_folder_id, cloud_id, sync_status, space_id, account_id)
             VALUES ('Projects', 1, 'shared-folder-key', 'b-cloud-folder', 'synced', ?, ?)`
          )
          .run(privateSpaceOf(device.db, ACCOUNT_B), ACCOUNT_B).lastInsertRowid
      );
      const bBefore = rowOf(device.db, "folders", bFolderId);
      const mine = sameNamed ? device.db.createFolder("Projects", defaultPrivate).folder : null;
      const cloudFolder = cloud.seedFolder({
        name: "Projects",
        client_folder_id: "shared-folder-key",
      });
      const [note] = seedPersonalNotes(cloud, 1, { folder_id: cloudFolder.id });

      assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

      assert.deepEqual(rowOf(device.db, "folders", bFolderId), bBefore, "B's folder is untouched");
      const aFolders = device.db.getFolders(defaultPrivate);
      assert.equal(aFolders.length, 1);
      assert.equal(aFolders[0].name, "Projects");
      assert.equal(aFolders[0].cloud_id, cloudFolder.id);
      assert.notEqual(aFolders[0].client_folder_id, "shared-folder-key");
      if (mine) assert.equal(aFolders[0].id, mine.id, "merged into the folder already here");
      assert.equal(device.db.getNoteByClientId(note.client_note_id).folder_id, aFolders[0].id);
    });
  }
});

// I4: a run that fails after storing a folder and a note under keys of their own (D28) leaves
// them for the next run to find by their cloud ids, so a change made here between the runs
// survives it.
test("a re-keyed folder and note keep a change made between a failed run and the next", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const bSpace = privateSpaceOf(device.db, ACCOUNT_B);
  device.db.db
    .prepare(
      `INSERT INTO folders (name, sort_order, client_folder_id, cloud_id, sync_status, space_id, account_id)
       VALUES ('Projects', 1, 'shared-folder-key', 'b-cloud-folder', 'synced', ?, ?)`
    )
    .run(bSpace, ACCOUNT_B);
  const cloudFolder = cloud.seedFolder({ name: "Projects", client_folder_id: "shared-folder-key" });
  const [note] = seedPersonalNotes(cloud, 1, { folder_id: cloudFolder.id });
  const bNote = device.db.upsertNoteFromCloud(
    { ...note, id: "b-cloud-row", content: "B's copy", folder_id: null },
    null
  );
  device.db.db
    .prepare("UPDATE notes SET account_id = ?, space_id = ?, folder_id = NULL WHERE id = ?")
    .run(ACCOUNT_B, bSpace, bNote.id);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  cloud.failNext((call) => routeOf(call) === SWITCH_ROUTE, { status: 503 });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");
  const aFolderRows = () =>
    device.db.db
      .prepare("SELECT * FROM folders WHERE account_id = ? AND cloud_id = ? AND deleted_at IS NULL")
      .all(ACCOUNT_A, cloudFolder.id);
  const aNoteRows = () =>
    device.db.db
      .prepare("SELECT * FROM notes WHERE account_id = ? AND cloud_id = ? AND deleted_at IS NULL")
      .all(ACCOUNT_A, note.id);
  const [folder] = aFolderRows();
  const [aNote] = aNoteRows();
  assert.notEqual(folder.client_folder_id, "shared-folder-key", "the folder took a key of its own");
  assert.notEqual(aNote.client_note_id, note.client_note_id, "the note took a key of its own");

  assert.ok(device.db.renameFolder(folder.id, "Client work").success);
  assert.ok(device.db.updateNote(aNote.id, { title: "Edited here" }).success);

  t.mock.timers.tick(5 * MINUTE_MS);
  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  assert.deepEqual(
    aFolderRows().map((row) => [row.id, row.name]),
    [[folder.id, "Client work"]],
    "the rename survives, and no second folder came in"
  );
  assert.deepEqual(
    aNoteRows().map((row) => [row.id, row.title]),
    [[aNote.id, "Edited here"]],
    "the edit survives, and no second note came in"
  );
  assert.equal(rowOf(device.db, "notes", aNote.id).folder_id, folder.id);
});

test("a custom cloud folder merges into the default Private's folder of that name", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const defaultPrivate = device.db.getDefaultPrivateSpaceId();
  const mine = device.db.createFolder("Projects", defaultPrivate).folder;
  const cloudFolder = cloud.seedFolder({ name: "Projects", client_folder_id: "cloud-projects" });
  const [note] = seedPersonalNotes(cloud, 1, { folder_id: cloudFolder.id });

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  const folders = device.db.getFolders(defaultPrivate);
  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.name, folder.cloud_id]),
    [[mine.id, "Projects", cloudFolder.id]]
  );
  assert.equal(device.db.getNoteByClientId(note.client_note_id).folder_id, mine.id);
});

test("a private folder deleted locally while its DELETE is still pending is not re-imported", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  const cloudFolder = cloud.seedFolder({ name: "Old project", client_folder_id: "cloud-old" });
  const [inFolder] = seedPersonalNotes(cloud, 1, {
    prefix: "in-folder",
    folder_id: cloudFolder.id,
  });
  const [kept] = seedPersonalNotes(cloud, 1, { prefix: "kept" });
  // Backed up here earlier, then deleted with its note; the cloud refuses the DELETE for now.
  const folder = device.db.upsertFolderFromCloud(cloudFolder);
  device.db.upsertNoteFromCloud(inFolder, folder.id);
  assert.equal(device.db.deleteFolder(folder.id).success, true);
  cloud.failWith("DELETE /api/folders/delete", { status: 503 });
  t.mock.method(console, "error", () => {});

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");

  assert.ok(rowOf(device.db, "folders", folder.id)?.deleted_at, "the folder stays a tombstone");
  assert.deepEqual(device.db.getFolders(device.db.getDefaultPrivateSpaceId()), []);
  assert.deepEqual(
    liveNotes(device.db).map((note) => note.client_note_id),
    [kept.client_note_id]
  );
});

test("a refused pulled_through fails once, logged, and stores nothing", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);
  cloud.failWith((call) => routeOf(call) === SWITCH_ROUTE, {
    status: 400,
    code: "invalid_pulled_through",
    error: "pulled_through is in the future",
  });
  const errors = t.mock.method(console, "error", () => {});

  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");

  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 1, "no retry");
  assert.equal(cloud.logFor(STATE_ROUTE).length, 1);
  assert.equal(markerOf(ACCOUNT_A), null);
  assert.deepEqual(device.api.syncEvents, []);
  assert.ok(
    errors.mock.calls.some((call) => call.arguments[0] === "Private notes import failed:"),
    "the failure is logged"
  );
});

test("a failed import waits before it runs again", async (t) => {
  await t.test("5 minutes, twice as long after each failure, an hour at most", () => {
    const { privateNotesImportRetryWait } = require("../../src/services/privateNotesImport.ts");
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 12].map((failures) => privateNotesImportRetryWait(failures) / MINUTE_MS),
      [5, 10, 20, 40, 60, 60, 60]
    );
  });

  await t.test("a pass inside the wait doesn't try", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    seedPersonalNotes(cloud, 1);
    st.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    st.mock.method(console, "error", () => {});
    const stateCalls = () => cloud.logFor(STATE_ROUTE).length;

    cloud.failNext((call) => routeOf(call) === STATE_ROUTE, { status: 503 });
    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");
    st.mock.timers.tick(5 * MINUTE_MS - 1);
    await device.service.syncAll(true);
    assert.equal(stateCalls(), 1, "5 minutes not yet up");

    st.mock.timers.tick(1);
    cloud.failNext((call) => routeOf(call) === STATE_ROUTE, { status: 503 });
    await device.service.syncAll(true);
    assert.equal(stateCalls(), 2, "tried again, and failed again");

    st.mock.timers.tick(10 * MINUTE_MS - 1);
    await device.service.syncAll(true);
    assert.equal(stateCalls(), 2, "the second wait is twice as long");

    st.mock.timers.tick(1);
    await device.service.syncAll(true);
    assert.equal(stateCalls(), 3);
    assert.deepEqual(JSON.parse(markerOf(ACCOUNT_A)), cloud.privateNotesState());
  });

  await t.test("a new sign-in starts afresh", async (st) => {
    const setup = await signedInDevice(st);
    if (!setup) return;
    const { device, cloud } = setup;
    seedPersonalNotes(cloud, 1);
    st.mock.method(console, "error", () => {});

    cloud.failNext((call) => routeOf(call) === STATE_ROUTE, { status: 503 });
    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "failed");
    device.signOut();
    await device.signIn(ACCOUNT_A, cloud);

    assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");
  });
});

test("an import that changes nothing lets team-only passes back off", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  seedPersonalNotes(cloud, 1);
  storage.setItem("cloudBackupEnabled", "false");
  cloud.failWith((call) => routeOf(call) === SWITCH_ROUTE, { status: 500 });
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  await device.service.syncAll(true);
  t.mock.timers.tick(5 * MINUTE_MS);
  await device.service.syncAll(true);

  assert.equal(cloud.logFor(SWITCH_ROUTE).length, 2, "the import ran in both passes");
  assert.equal(
    storage.getItem("teamOnlyPass.emptyStreak"),
    "1",
    "the second pass moved nothing but the import's snapshot, and counts as empty"
  );
});

test("import recognizes a backed-up note moved into its teamspace", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-a",
    defaultWorkspaceId: "workspace-a",
  });
  device.db.bindDefaultPrivateSpace("workspace-a");
  const [remote] = seedPersonalNotes(cloud, 1);
  const privateId = device.db.getDefaultPrivateSpaceId();
  const local = device.db.upsertNoteFromCloud(remote, null, privateId);
  const teamId = Number(
    device.db.db
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, workspace_id) VALUES (?, 'team', ?, ?)"
      )
      .run("import-team", "Team", "workspace-a").lastInsertRowid
  );
  device.db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(teamId, ACCOUNT_A);
  assert.equal(device.db.updateNote(local.id, { space_id: teamId }).success, true);
  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");
  assert.deepEqual(
    liveNotes(device.db).map((note) => note.space_id),
    [teamId]
  );
});

test("import recognizes a moved note whose create receipt was lost", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-a",
    defaultWorkspaceId: "workspace-a",
  });
  device.db.bindDefaultPrivateSpace("workspace-a");
  const [remote] = seedPersonalNotes(cloud, 1);
  const local = device.db.upsertNoteFromCloud(remote, null, device.db.getDefaultPrivateSpaceId());
  device.db.updateNote(local.id, { cloud_id: null });
  const teamId = Number(
    device.db.db
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, workspace_id) VALUES (?, 'team', ?, ?)"
      )
      .run("lost-receipt-team", "Team", "workspace-a").lastInsertRowid
  );
  device.db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(teamId, ACCOUNT_A);
  assert.equal(device.db.updateNote(local.id, { space_id: teamId }).success, true);
  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");
  assert.deepEqual(
    liveNotes(device.db).map((note) => note.space_id),
    [teamId]
  );
});

test("import does not restore a moved folder's deleted note", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-a",
    defaultWorkspaceId: "workspace-a",
  });
  device.db.bindDefaultPrivateSpace("workspace-a");
  const [remote] = seedPersonalNotes(cloud, 1);
  const privateId = device.db.getDefaultPrivateSpaceId();
  const folder = device.db.createFolder("Private folder", privateId).folder;
  const local = device.db.upsertNoteFromCloud(remote, folder.id, privateId);
  const teamId = Number(
    device.db.db
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, workspace_id) VALUES (?, 'team', ?, ?)"
      )
      .run("folder-import-team", "Team", "workspace-a").lastInsertRowid
  );
  device.db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(teamId, ACCOUNT_A);
  assert.equal(device.db.moveFolderToSpace(folder.id, teamId).success, true);
  device.db.deleteNote(local.id);
  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_A), "switched");
  assert.equal(liveNotes(device.db).length, 0);
});

test("another account's colliding cloud key is not suppressed by move history", async (t) => {
  const setup = await signedInDevice(t);
  if (!setup) return;
  const { device, cloud } = setup;
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-a",
    defaultWorkspaceId: "workspace-a",
  });
  device.db.bindDefaultPrivateSpace("workspace-a");
  const [remote] = seedPersonalNotes(cloud, 1);
  const local = device.db.upsertNoteFromCloud(remote, null, device.db.getDefaultPrivateSpaceId());
  const teamId = Number(
    device.db.db
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, workspace_id) VALUES (?, 'team', ?, ?)"
      )
      .run("account-team", "Team", "workspace-a").lastInsertRowid
  );
  device.db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(teamId, ACCOUNT_A);
  assert.equal(device.db.updateNote(local.id, { space_id: teamId }).success, true);
  const cloudB = createAccountCloud({ privateNotesRoutes: true });
  serverClockBehind(cloudB);
  seedPersonalNotes(cloudB, 1);
  await device.signIn(ACCOUNT_B, cloudB);
  assert.equal(await device.service.importCloudPrivateNotes(ACCOUNT_B), "switched");
  assert.equal(liveNotes(device.db).filter((note) => note.account_id === ACCOUNT_B).length, 1);
});
