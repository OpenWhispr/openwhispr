const test = require("node:test");
const assert = require("node:assert/strict");

const note = {
  id: 42,
  client_note_id: "client-note-42",
};

test("resolveCloudNoteCreate deletes a proven orphan create", async () => {
  const { resolveCloudNoteCreate } = await import("../../src/services/noteCreateAck.ts");
  const calls = [];
  const result = await resolveCloudNoteCreate(
    note,
    {
      id: "cloud-note-42",
      client_note_id: note.client_note_id,
      updated_at: "2026-07-29T10:00:00.000Z",
      user_id: "owner-42",
    },
    {
      acknowledge: async (...args) => {
        calls.push(["acknowledge", ...args]);
        return { success: true, outcome: "orphaned" };
      },
      deleteCloud: async (cloudId) => calls.push(["delete", cloudId]),
    }
  );

  assert.equal(result, "orphan-cleaned");
  assert.deepEqual(calls[0], [
    "acknowledge",
    note.id,
    note,
    "cloud-note-42",
    "2026-07-29T10:00:00.000Z",
    "owner-42",
    true,
  ]);
  assert.deepEqual(calls[1], ["delete", "cloud-note-42"]);
});

test("resolveCloudNoteCreate never deletes a mismatched response", async () => {
  const { resolveCloudNoteCreate } = await import("../../src/services/noteCreateAck.ts");
  let acknowledged = false;
  let deleted = false;
  let invalid = null;
  const result = await resolveCloudNoteCreate(
    note,
    { id: "foreign-cloud-note", client_note_id: "someone-else" },
    {
      acknowledge: async () => {
        acknowledged = true;
        return { success: true, outcome: "orphaned" };
      },
      deleteCloud: async () => {
        deleted = true;
      },
      onInvalidResponse: (expected, received) => {
        invalid = { expected, received };
      },
    }
  );

  assert.equal(result, "invalid-response");
  assert.equal(acknowledged, false);
  assert.equal(deleted, false);
  assert.deepEqual(invalid, {
    expected: note.client_note_id,
    received: "someone-else",
  });
});

test("resolveCloudNoteCreate leaves newer local work pending without cleanup", async () => {
  const { resolveCloudNoteCreate } = await import("../../src/services/noteCreateAck.ts");
  let deleted = false;
  const result = await resolveCloudNoteCreate(
    note,
    { id: "cloud-note-42", client_note_id: note.client_note_id },
    {
      acknowledge: async () => ({ success: true, outcome: "pending" }),
      deleteCloud: async () => {
        deleted = true;
      },
    }
  );

  assert.equal(result, "pending");
  assert.equal(deleted, false);
});

test("resolveCloudNoteCreate treats orphan cleanup as best-effort", async () => {
  const { resolveCloudNoteCreate } = await import("../../src/services/noteCreateAck.ts");
  const failure = new Error("signed out");
  let reported = null;
  const result = await resolveCloudNoteCreate(
    note,
    { id: "cloud-note-42", client_note_id: note.client_note_id },
    {
      acknowledge: async () => ({ success: true, outcome: "orphaned" }),
      deleteCloud: async () => {
        throw failure;
      },
      onCleanupError: (cloud, error) => {
        reported = { cloud, error };
      },
    }
  );

  assert.equal(result, "orphan-cleanup-failed");
  assert.equal(reported.cloud.id, "cloud-note-42");
  assert.equal(reported.error, failure);
});

test("resolveCloudNoteCreateBatch routes migration results by snapshot identity", async () => {
  const { resolveCloudNoteCreateBatch } = await import("../../src/services/noteCreateAck.ts");
  const otherNote = { id: 84, client_note_id: "client-note-84" };
  const acknowledgements = [];
  const deleted = [];
  const results = await resolveCloudNoteCreateBatch(
    [note, otherNote],
    [
      {
        id: "cloud-note-84",
        client_note_id: otherNote.client_note_id,
        updated_at: "2026-07-29T14:00:00.000Z",
      },
    ],
    {
      acknowledge: async (...args) => {
        acknowledgements.push(args);
        return { success: true, outcome: "orphaned" };
      },
      deleteCloud: async (cloudId) => deleted.push(cloudId),
    },
    { settleIfUnchanged: false }
  );

  assert.deepEqual(acknowledgements, [
    [otherNote.id, otherNote, "cloud-note-84", "2026-07-29T14:00:00.000Z", null, false],
  ]);
  assert.deepEqual(deleted, ["cloud-note-84"]);
  assert.deepEqual(results, ["orphan-cleaned"]);
});

test("resolveCloudNoteCreateBatch does not delete an unmatched migration response", async () => {
  const { resolveCloudNoteCreateBatch } = await import("../../src/services/noteCreateAck.ts");
  let acknowledged = false;
  let deleted = false;
  let unmatched = null;
  const cloud = { id: "unknown-cloud", client_note_id: "unknown-client" };
  const results = await resolveCloudNoteCreateBatch([note], [cloud], {
    acknowledge: async () => {
      acknowledged = true;
      return { success: true, outcome: "orphaned" };
    },
    deleteCloud: async () => {
      deleted = true;
    },
    onUnmatchedResponse: (response) => {
      unmatched = response;
    },
  });

  assert.deepEqual(results, ["unmatched-response"]);
  assert.equal(acknowledged, false);
  assert.equal(deleted, false);
  assert.equal(unmatched, cloud);
});

test("a superseded migration run acknowledges instead of deleting the idempotent row", async () => {
  const { resolveCloudNoteCreateBatch } = await import("../../src/services/noteCreateAck.ts");
  let migrationGeneration = 1;
  let accountGeneration = 7;
  const run = {
    migrationGeneration,
    accountGeneration,
  };
  migrationGeneration += 1;

  let acknowledged = false;
  let deleted = false;
  const results = await resolveCloudNoteCreateBatch(
    [note],
    [{ id: "shared-idempotent-cloud", client_note_id: note.client_note_id }],
    {
      acknowledge: async () => {
        acknowledged = true;
        return { success: true, outcome: "already-linked" };
      },
      deleteCloud: async () => {
        deleted = true;
      },
    },
    {
      settleIfUnchanged: false,
      requestStillCurrent: () => run.accountGeneration === accountGeneration,
    }
  );

  assert.notEqual(run.migrationGeneration, migrationGeneration);
  assert.equal(acknowledged, true);
  assert.equal(deleted, false);
  assert.deepEqual(results, ["already-linked"]);
});

test("an account reset cleans an invalidated migration without touching SQLite", async () => {
  const { resolveCloudNoteCreateBatch } = await import("../../src/services/noteCreateAck.ts");
  let accountGeneration = 7;
  const runAccountGeneration = accountGeneration;
  accountGeneration += 1;
  let acknowledged = false;
  const deleted = [];
  const cloud = { id: "old-account-cloud", client_note_id: note.client_note_id };
  const results = await resolveCloudNoteCreateBatch(
    [note],
    [cloud],
    {
      acknowledge: async () => {
        acknowledged = true;
        return { success: true, outcome: "synced" };
      },
      deleteCloud: async (cloudId) => deleted.push(cloudId),
    },
    {
      settleIfUnchanged: false,
      requestStillCurrent: () => runAccountGeneration === accountGeneration,
    }
  );

  assert.equal(acknowledged, false);
  assert.deepEqual(deleted, ["old-account-cloud"]);
  assert.deepEqual(results, ["orphan-cleaned"]);
});
