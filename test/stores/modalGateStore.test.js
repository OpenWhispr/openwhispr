const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/stores/modalGateStore.ts");

test("the gate holds while any gated modal is open and counts repeats", async () => {
  const { useModalGateStore, selectGatedModalOpen } = await load();
  const { setModalOpen } = useModalGateStore.getState();
  const isOpen = () => selectGatedModalOpen(useModalGateStore.getState());

  assert.equal(isOpen(), false);
  setModalOpen("notesStructureIntro", true);
  setModalOpen("notesStructureIntro", true);
  setModalOpen("joinYourTeam", true);
  assert.equal(isOpen(), true);

  setModalOpen("joinYourTeam", false);
  setModalOpen("notesStructureIntro", false);
  assert.equal(isOpen(), true, "one structure intro is still mounted open");

  setModalOpen("notesStructureIntro", false);
  assert.equal(isOpen(), false);
});

test("an extra release never leaves a negative count behind", async () => {
  const { useModalGateStore, selectGatedModalOpen } = await load();
  const { setModalOpen } = useModalGateStore.getState();

  setModalOpen("postMigration", false);
  setModalOpen("postMigration", true);
  assert.equal(selectGatedModalOpen(useModalGateStore.getState()), true);
  setModalOpen("postMigration", false);
  assert.deepEqual(useModalGateStore.getState().open, {});
});
