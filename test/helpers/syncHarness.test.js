const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { assertNoContentRegression } = require("./harness/invariants.js");

const T1 = "2026-07-20T10:00:00.000Z";
const T2 = "2026-07-20T11:00:00.000Z";

function note(overrides = {}) {
  return {
    id: "local-1",
    client_note_id: "client-1",
    content: "important text",
    transcript: null,
    enhanced_content: null,
    deleted_at: null,
    updated_at: T1,
    ...overrides,
  };
}

test("content invariant rejects a note that disappears without a cloud tombstone", () => {
  assert.throws(
    () => assertNoContentRegression([note()], [], []),
    /sync hard-deleted note local-1/
  );
});

test("content invariant allows a note removed by a current cloud tombstone", () => {
  const tombstone = note({ id: "note-1", deleted_at: T2, updated_at: T2 });
  assert.doesNotThrow(() => assertNoContentRegression([note()], [], [tombstone]));
});

test("fake cloud paginates tied timestamps with the composite cursor id", async () => {
  const cloud = createFakeCloud();
  for (let i = 1; i <= 51; i += 1) {
    cloud.seedNote({
      client_note_id: `client-${i}`,
      content: `note ${i}`,
      created_at: T1,
      updated_at: T1,
    });
  }

  const snapshotFirst = await cloud.request({
    path: `/api/notes/list?limit=50&before=${encodeURIComponent(T2)}`,
  });
  assert.equal(snapshotFirst.success, true);
  assert.equal(snapshotFirst.data.notes.length, 50);
  const snapshotCursor = snapshotFirst.data.notes.at(-1);
  const snapshotSecond = await cloud.request({
    path:
      `/api/notes/list?limit=50&before=${encodeURIComponent(snapshotCursor.created_at)}` +
      `&before_id=${snapshotCursor.id}`,
  });
  assert.deepEqual(
    snapshotSecond.data.notes.map((row) => row.id),
    ["note-0001"]
  );

  const deltaFirst = await cloud.request({
    path: `/api/notes/list?limit=50&since=${encodeURIComponent(T1)}` + "&since_id=note-0000",
  });
  assert.equal(deltaFirst.success, true);
  assert.equal(deltaFirst.data.notes.length, 50);
  const deltaCursor = deltaFirst.data.notes.at(-1);
  const deltaSecond = await cloud.request({
    path:
      `/api/notes/list?limit=50&since=${encodeURIComponent(deltaCursor.updated_at)}` +
      `&since_id=${deltaCursor.id}`,
  });
  assert.deepEqual(
    deltaSecond.data.notes.map((row) => row.id),
    ["note-0051"]
  );
});

const post = (cloud, path, body) => cloud.request({ method: "POST", path, body });

test("fake cloud keeps one word or trigger per account whatever its case, as the API does", async () => {
  const cloud = createFakeCloud();
  cloud.setClock(() => T2);
  const first = cloud.seedDictionaryEntry({
    word: "Kubernetes",
    client_dict_id: "first-device",
    source: "manual",
    created_at: T1,
    updated_at: T1,
  });
  await cloud.request({ method: "DELETE", path: "/api/dictionary/delete", body: first });

  // Another device adds the word again under its own client id.
  const { data } = await post(cloud, "/api/dictionary/batch-create", {
    entries: [
      { word: "kubernetes", client_dict_id: "second-device", source: "learned", updated_at: T1 },
    ],
  });
  assert.equal(cloud.dictionary().length, 1, "the create took the existing row over");
  assert.deepEqual(
    { ...data.created[0], created_at: undefined },
    {
      id: first.id,
      client_dict_id: "second-device",
      word: "kubernetes",
      source: "manual",
      deleted_at: null,
      created_at: undefined,
      updated_at: T2,
    },
    "revived, re-keyed to the new writer, still manual and stamped by the server"
  );

  const snippet = cloud.seedSnippet({
    trigger: "addr",
    replacement: "old",
    client_snippet_id: "s1",
  });
  const renamed = await post(cloud, "/api/snippets/batch-create", {
    entries: [{ trigger: "address", replacement: "new", client_snippet_id: "s1" }],
  });
  assert.equal(renamed.data.created[0].id, snippet.id, "a known client id renames its row");
  const taken = await post(cloud, "/api/snippets/batch-create", {
    entries: [{ trigger: "Address", replacement: "x", client_snippet_id: "s2" }],
  });
  assert.equal(taken.data.created[0].client_snippet_id, "s2");
  assert.equal(cloud.snippets().length, 1);
});

test("fake cloud answers a repeated transcription create with the row it already holds", async () => {
  const cloud = createFakeCloud();
  const body = { text: "hello", client_transcription_id: "t-1", created_at: T1 };
  const first = await post(cloud, "/api/transcriptions/create", body);
  const batch = await post(cloud, "/api/transcriptions/batch-create", {
    transcriptions: [{ ...body, text: "hello again" }],
  });
  assert.equal(batch.data.created[0].id, first.data.id);
  assert.deepEqual(
    cloud.transcriptions().map((row) => row.text),
    ["hello again"]
  );
});

// As lib/notes-service.ts and lib/folders-service.ts: a note create landing on
// a deleted row stays deleted, a folder create revives it.
test("fake cloud keeps a deleted note deleted on a create and revives a folder", async () => {
  const cloud = createFakeCloud();
  const noteRow = cloud.seedNote({ client_note_id: "n-1", title: "Old", content: "old" });
  cloud.deleteNote(noteRow.id);
  const folderRow = cloud.seedFolder({ client_folder_id: "f-1", name: "Old" });
  await cloud.request({
    method: "DELETE",
    path: "/api/folders/delete",
    body: { id: folderRow.id },
  });

  const createdNote = await post(cloud, "/api/notes/create", {
    client_note_id: "n-1",
    title: "New",
    content: "new",
    space_id: null,
  });
  const createdFolder = await post(cloud, "/api/folders/create", {
    client_folder_id: "f-1",
    name: "New",
    space_id: null,
  });

  assert.equal(createdNote.data.id, noteRow.id);
  assert.ok(createdNote.data.deleted_at, "the delete wins");
  assert.equal(createdFolder.data.id, folderRow.id);
  assert.equal(createdFolder.data.deleted_at, null, "the folder is back");
});

// The bridge stands in for main's sync-write fence and chat-ack sender check;
// a SyncService test proves nothing about them unless it refuses what main does.
test("the bridge refuses a sync write once its sign-in's account is no longer the active one", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const api = createElectronApi(db);
  const { generation } = await api.authGetTokenState();
  const dictation = db.saveTranscription("hello").transcription;

  // The session is revoked under the same token.
  db.setActiveAccountId(null);
  assert.equal(
    (await api.markTranscriptionSynced(dictation.id, "cloud-1", generation)).stale,
    true
  );
  assert.deepEqual(await api.clearDictionaryCloudId(1, generation), {
    success: false,
    stale: true,
  });

  db.setActiveAccountId("account-a");
  assert.equal(
    (await api.markTranscriptionSynced(dictation.id, "cloud-1", generation)).success,
    true
  );
  api.authState.generation += 1;
  assert.equal(
    (await api.markTranscriptionSynced(dictation.id, "cloud-1", generation)).stale,
    true
  );
});

test("the bridge records a chat ack only for the account its sign-in was scoped to", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const api = createElectronApi(db);
  const { generation } = await api.authGetTokenState();
  const chat = db.createAgentConversation("chat");
  db.addAgentMessage(chat.id, "user", "hello");
  const full = db.getAgentConversation(chat.id);
  const snapshot = {
    client_conversation_id: full.client_conversation_id,
    title: full.title,
    updated_at: full.updated_at,
    message_count: 1,
  };

  assert.deepEqual(
    await api.acknowledgeConversationCreate(chat.id, snapshot, "cloud-1", "account-b", generation),
    { success: false, outcome: "unresolved", cloud_id: null }
  );
  assert.equal(db.getAgentConversation(chat.id).cloud_id, null);

  // The sender is still named after another account became active.
  db.setActiveAccountId("account-b");
  api.authState.generation += 1;
  const acked = await api.acknowledgeConversationCreate(
    chat.id,
    snapshot,
    "cloud-1",
    "account-a",
    generation
  );
  assert.equal(acked.outcome, "synced");
});
