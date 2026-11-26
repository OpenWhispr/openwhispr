// A sync pass belongs to the sign-in it started under. Held on one request while
// the user signs out and another account signs in, it must end there: carried
// on, it would run its remaining stages as the next account against the cursor
// slots the departed account claimed, and that account would never receive
// what its other devices changed before the stamp. Real DatabaseManager and
// SyncService on one window; only HTTP is faked, with one cloud per account.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");
const { deferred } = require("./harness/deferred.js");
const { localStorage: localStorageStub } = require("./harness/browserGlobals.js");

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

// In the order a pass stamps them.
const CURSORS = [
  "lastSyncedAt.notes",
  "lastSyncedAt.conversations",
  "lastSyncedAt.transcriptions",
  "lastSyncedAt.dictionary",
  "lastSyncedAt.dictionary.id",
  "lastSyncedAt.snippets",
  "lastSyncedAt.snippets.id",
];
const cursors = () =>
  Object.fromEntries(CURSORS.map((key) => [key, localStorageStub.getItem(key)]));

// Holds the first request the matcher accepts until `release()`.
function holdRequest(device, matches) {
  const reached = deferred();
  const held = deferred();
  let armed = true;
  device.hooks.beforeRequest = async (call) => {
    if (!armed || !matches(call)) return;
    armed = false;
    reached.resolve();
    await held.promise;
  };
  return { reached: reached.promise, release: held.resolve };
}

// A's cloud after A's last pass here: another device added a word and a
// dictation and deleted one. B's cloud holds a word edited later than all of it.
async function accountsWithChangesSinceLastPass(device) {
  const cloudA = createAccountCloud();
  const cloudB = createAccountCloud();
  cloudA.seedDictionaryEntry({
    word: "Alpha",
    client_dict_id: "a-old",
    created_at: minutesAgo(600),
    updated_at: minutesAgo(600),
  });
  const oldDictation = cloudA.seedTranscription({
    text: "A's old dictation",
    client_transcription_id: "a-t-old",
    created_at: minutesAgo(600),
    updated_at: minutesAgo(600),
  });
  await device.signIn("account-a", cloudA);
  await device.service.syncAll(true);

  await pause();
  const gap = new Date().toISOString();
  cloudA.seedDictionaryEntry({
    word: "GapWord",
    client_dict_id: "a-gap",
    created_at: gap,
    updated_at: gap,
  });
  cloudA.seedTranscription({
    text: "A's new dictation",
    client_transcription_id: "a-t-gap",
    created_at: gap,
    updated_at: gap,
  });
  cloudA.deleteTranscription(oldDictation.id);
  await pause();
  const later = new Date().toISOString();
  cloudB.seedDictionaryEntry({
    word: "Bravo",
    client_dict_id: "b-word",
    created_at: minutesAgo(900),
    updated_at: later,
  });
  return { cloudA, cloudB };
}

async function switchToB(device, cloudB) {
  device.signOut();
  await device.signIn("account-b", cloudB);
}

async function expectAReceivesItsChanges(device, cloudA, cloudB) {
  await device.service.syncAll(true);
  device.signOut();
  await device.signIn("account-a", cloudA);
  await device.service.syncAll(true);
  assert.deepEqual(device.db.getDictionary().sort(), ["Alpha", "GapWord"]);
  assert.deepEqual(
    device.db
      .getTranscriptions()
      .map((row) => row.text)
      .sort(),
    ["A's new dictation", "A's unsent dictation"],
    "the new dictation arrives and the deleted one goes"
  );
  assert.equal(
    cloudB.log.some((call) => call.method !== "GET"),
    false,
    "nothing was written to B's cloud on A's behalf"
  );
}

// Each case names the request the pass hangs on and the first cursor it had
// not reached yet: that one and every later one must still be A's own.
for (const [stage, heldRoute, firstUntouched] of [
  ["between stages (its note pull)", "/api/notes/list", "lastSyncedAt.conversations"],
  [
    "inside a stage (its dictation push)",
    "/api/transcriptions/batch-create",
    "lastSyncedAt.transcriptions",
  ],
]) {
  test(`a pass held ${stage} across an account switch ends there`, async (t) => {
    const device = createSyncDevice(t);
    if (!device) return;
    const { cloudA, cloudB } = await accountsWithChangesSinceLastPass(device);
    device.db.saveTranscription("A's unsent dictation", null, {
      clientTranscriptionId: "a-unsent",
    });
    const before = cursors();

    const hold = holdRequest(device, (call) => routeOf(call) === heldRoute);
    const pass = device.service.syncAll(true);
    await hold.reached;
    await switchToB(device, cloudB);
    hold.release();
    await pass;

    assert.deepEqual(cloudB.log, [], "the held pass asks B's cloud for nothing");
    const after = cursors();
    assert.equal(localStorageStub.getItem("lastSyncedAt.accountId"), "account-a");
    for (const key of CURSORS.slice(CURSORS.indexOf(firstUntouched))) {
      assert.equal(after[key], before[key], `${key} is still A's own`);
    }

    await expectAReceivesItsChanges(device, cloudA, cloudB);
  });
}

test("a dictionary edit's sync held across an account switch leaves the cursors alone", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const { cloudB } = await accountsWithChangesSinceLastPass(device);
  device.db.applyDictionaryChanges({ add: ["Edited"] });
  const before = cursors();

  const hold = holdRequest(device, (call) => routeOf(call) === "/api/dictionary/batch-create");
  const edit = device.service.syncDictionaryNow();
  await hold.reached;
  await switchToB(device, cloudB);
  hold.release();
  await edit;

  assert.deepEqual(cloudB.log, [], "the held sync asks B's cloud for nothing");
  assert.deepEqual(cursors(), before);
  assert.equal(localStorageStub.getItem("lastSyncedAt.accountId"), "account-a");
});
