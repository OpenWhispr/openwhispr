const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/versionedIntro.ts");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("versioned intros are shown until their current version is recorded", async () => {
  const { CONTAINER_OVERVIEW_INTRO, markIntroSeen, shouldShowIntro } = await load();
  const storage = memoryStorage();

  assert.equal(shouldShowIntro(storage, CONTAINER_OVERVIEW_INTRO), true);
  markIntroSeen(storage, CONTAINER_OVERVIEW_INTRO);
  assert.equal(
    storage.getItem(CONTAINER_OVERVIEW_INTRO.storageKey),
    String(CONTAINER_OVERVIEW_INTRO.version)
  );
  assert.equal(shouldShowIntro(storage, CONTAINER_OVERVIEW_INTRO), false);
});

test("a version bump reopens an intro", async () => {
  const { NOTES_STRUCTURE_INTRO, shouldShowIntro } = await load();
  const storage = memoryStorage({ [NOTES_STRUCTURE_INTRO.storageKey]: "1" });

  assert.equal(shouldShowIntro(storage, NOTES_STRUCTURE_INTRO, 1), false);
  assert.equal(shouldShowIntro(storage, NOTES_STRUCTURE_INTRO, 2), true);
});

test("malformed versions do not suppress an intro", async () => {
  const { CONTAINER_OVERVIEW_INTRO, shouldShowIntro } = await load();
  const storage = memoryStorage({ [CONTAINER_OVERVIEW_INTRO.storageKey]: "not-a-number" });

  assert.equal(shouldShowIntro(storage, CONTAINER_OVERVIEW_INTRO), true);
});

test("intro configurations use independent storage keys", async () => {
  const { CONTAINER_OVERVIEW_INTRO, NOTES_STRUCTURE_INTRO, markIntroSeen, shouldShowIntro } =
    await load();
  const storage = memoryStorage();

  markIntroSeen(storage, CONTAINER_OVERVIEW_INTRO);

  assert.equal(shouldShowIntro(storage, CONTAINER_OVERVIEW_INTRO), false);
  assert.equal(shouldShowIntro(storage, NOTES_STRUCTURE_INTRO), true);
});
