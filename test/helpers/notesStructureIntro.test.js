const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/notesStructureIntro.ts");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("notes structure intro is shown until the current version is recorded", async () => {
  const {
    NOTES_STRUCTURE_INTRO_STORAGE_KEY,
    NOTES_STRUCTURE_INTRO_VERSION,
    markNotesStructureIntroSeen,
    shouldShowNotesStructureIntro,
  } = await load();
  const storage = memoryStorage();

  assert.equal(shouldShowNotesStructureIntro(storage), true);
  markNotesStructureIntroSeen(storage);
  assert.equal(
    storage.getItem(NOTES_STRUCTURE_INTRO_STORAGE_KEY),
    String(NOTES_STRUCTURE_INTRO_VERSION)
  );
  assert.equal(shouldShowNotesStructureIntro(storage), false);
});

test("a version bump reopens the notes structure intro", async () => {
  const { NOTES_STRUCTURE_INTRO_STORAGE_KEY, shouldShowNotesStructureIntro } = await load();
  const storage = memoryStorage({ [NOTES_STRUCTURE_INTRO_STORAGE_KEY]: "1" });

  assert.equal(shouldShowNotesStructureIntro(storage, 1), false);
  assert.equal(shouldShowNotesStructureIntro(storage, 2), true);
});

test("malformed stored versions do not suppress the intro", async () => {
  const { NOTES_STRUCTURE_INTRO_STORAGE_KEY, shouldShowNotesStructureIntro } = await load();
  const storage = memoryStorage({ [NOTES_STRUCTURE_INTRO_STORAGE_KEY]: "not-a-version" });

  assert.equal(shouldShowNotesStructureIntro(storage), true);
});
