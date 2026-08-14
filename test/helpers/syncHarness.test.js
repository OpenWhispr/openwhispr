const test = require("node:test");
const assert = require("node:assert/strict");

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
