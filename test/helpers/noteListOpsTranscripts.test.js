const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/stores/noteListOps.ts");

const note = (id, transcript = "[]") => ({ id, folder_id: 1, space_id: 1, transcript });

test("clears the transcript in every list that holds the note, in place", async () => {
  const { clearTranscriptsInLists } = await load();
  const state = {
    notesByContainer: { "f:1": [note(1), note(2), note(3)] },
    notes: [note(2), note(3)],
  };

  const result = clearTranscriptsInLists(state, [2]);

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.notesByContainer["f:1"].map(({ id, transcript }) => [id, transcript]),
    [
      [1, "[]"],
      [2, null],
      [3, "[]"],
    ]
  );
  assert.deepEqual(
    result.notes.map(({ id, transcript }) => [id, transcript]),
    [
      [2, null],
      [3, "[]"],
    ]
  );
});

test("a note no list holds is not added, and nothing changes", async () => {
  const { clearTranscriptsInLists } = await load();
  const state = { notesByContainer: { "f:1": [note(1)] }, notes: [note(1)] };

  const result = clearTranscriptsInLists(state, [40]);

  assert.equal(result.changed, false);
  assert.deepEqual(result.notesByContainer, state.notesByContainer);
  assert.deepEqual(result.notes, state.notes);
});
