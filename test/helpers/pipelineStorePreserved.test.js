const test = require("node:test");
const assert = require("node:assert/strict");

// handlePipelineStatus destructures a fixed field set and deletes the note's entry on
// pipeline:complete — so a "preserved" flag would be dropped, then erased, and the user
// would never learn their transcript was kept rather than upgraded.
async function loadStore() {
  const mod = await import("../../src/stores/postCallPipelineStore.ts");
  mod.usePostCallPipelineStore.setState({ activePipelines: {} });
  return mod;
}

test("a preserved outcome is carried through and survives pipeline completion", async () => {
  const { handlePipelineStatus, usePostCallPipelineStore, selectPipelineForNote } =
    await loadStore();

  handlePipelineStatus({ noteId: 3, step: "retranscribe", status: "running" });
  handlePipelineStatus({
    noteId: 3,
    step: "retranscribe",
    status: "complete",
    preserved: true,
    reason: "incomplete-source-coverage",
  });
  handlePipelineStatus({ noteId: 3, step: "pipeline", status: "complete" });

  const state = selectPipelineForNote(usePostCallPipelineStore.getState(), 3);
  assert.equal(state?.preservedReason, "incomplete-source-coverage");
});

test("an ordinary pipeline still clears itself on completion", async () => {
  const { handlePipelineStatus, usePostCallPipelineStore, selectPipelineForNote } =
    await loadStore();

  handlePipelineStatus({ noteId: 4, step: "retranscribe", status: "complete" });
  handlePipelineStatus({ noteId: 4, step: "pipeline", status: "complete" });

  assert.equal(selectPipelineForNote(usePostCallPipelineStore.getState(), 4), null);
});

test("a later step does not erase an earlier preserved reason", async () => {
  const { handlePipelineStatus, usePostCallPipelineStore, selectPipelineForNote } =
    await loadStore();

  handlePipelineStatus({
    noteId: 5,
    step: "retranscribe",
    status: "complete",
    preserved: true,
    reason: "no-segments",
  });
  handlePipelineStatus({ noteId: 5, step: "title", status: "running" });
  handlePipelineStatus({ noteId: 5, step: "notes", status: "complete" });

  const state = selectPipelineForNote(usePostCallPipelineStore.getState(), 5);
  assert.equal(state?.preservedReason, "no-segments");
});
