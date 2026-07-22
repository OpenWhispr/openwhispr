const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/containerOverviewIntro.ts");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("container overview intro is shown until the current version is recorded", async () => {
  const {
    CONTAINER_OVERVIEW_INTRO_STORAGE_KEY,
    CONTAINER_OVERVIEW_INTRO_VERSION,
    markContainerOverviewIntroSeen,
    shouldShowContainerOverviewIntro,
  } = await load();
  const storage = memoryStorage();

  assert.equal(shouldShowContainerOverviewIntro(storage), true);
  markContainerOverviewIntroSeen(storage);
  assert.equal(
    storage.getItem(CONTAINER_OVERVIEW_INTRO_STORAGE_KEY),
    String(CONTAINER_OVERVIEW_INTRO_VERSION)
  );
  assert.equal(shouldShowContainerOverviewIntro(storage), false);
});

test("a version bump reopens the container overview intro", async () => {
  const { CONTAINER_OVERVIEW_INTRO_STORAGE_KEY, shouldShowContainerOverviewIntro } = await load();
  const storage = memoryStorage({ [CONTAINER_OVERVIEW_INTRO_STORAGE_KEY]: "1" });

  assert.equal(shouldShowContainerOverviewIntro(storage, 1), false);
  assert.equal(shouldShowContainerOverviewIntro(storage, 2), true);
});

test("malformed stored versions do not suppress the intro", async () => {
  const { CONTAINER_OVERVIEW_INTRO_STORAGE_KEY, shouldShowContainerOverviewIntro } = await load();
  const storage = memoryStorage({ [CONTAINER_OVERVIEW_INTRO_STORAGE_KEY]: "not-a-number" });

  assert.equal(shouldShowContainerOverviewIntro(storage), true);
});
