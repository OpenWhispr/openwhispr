const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const skill = (name, enabled = true) => ({
  name,
  displayName: name,
  description: `${name} skill`,
  enabled,
  valid: true,
  addedAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  lastUsedAt: null,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function loadStore(t, electronAPI) {
  const windowListeners = {};
  installBrowserGlobals(t, {
    window: {
      electronAPI,
      addEventListener: (type, listener) => {
        windowListeners[type] = listener;
      },
      removeEventListener: (type, listener) => {
        if (windowListeners[type] === listener) delete windowListeners[type];
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-skills-store-test-" });
  const store = await vite.ssrLoadModule("/stores/skillsStore.ts");
  return { store, windowListeners };
}

function libraryApi(lists) {
  const api = {
    lists: 0,
    changed: null,
    skillsList: async () => ({ skills: lists[Math.min(api.lists++, lists.length - 1)] }),
    onSkillsChanged: (callback) => {
      api.changed = callback;
      return () => {};
    },
  };
  return api;
}

test("each refresh reads the list again", async (t) => {
  const api = libraryApi([[skill("first")], [skill("first"), skill("second")]]);
  const { store } = await loadStore(t, api);

  await store.refreshSkills();
  assert.equal(api.lists, 1);
  assert.deepEqual(
    store.useSkillsStore.getState().skills.map((entry) => entry.name),
    ["first"]
  );

  await store.refreshSkills();
  assert.equal(api.lists, 2);
  assert.deepEqual(
    store.useSkillsStore.getState().skills.map((entry) => entry.name),
    ["first", "second"]
  );
  assert.equal(store.useSkillsStore.getState().loaded, true);
});

test("a skills-changed event refreshes the list", async (t) => {
  const api = libraryApi([[], [skill("added")]]);
  const { store } = await loadStore(t, api);
  const names = () => store.useSkillsStore.getState().skills.map((entry) => entry.name);
  await store.refreshSkills();

  api.changed();
  await settle();
  assert.deepEqual([api.lists, names()], [2, ["added"]]);
});

// A window focus anywhere in the app would otherwise reread every skill folder.
test("a window focus rereads the list only while the Skills page asks for it", async (t) => {
  const api = libraryApi([[], [skill("edited-outside")]]);
  const { store, windowListeners } = await loadStore(t, api);
  await store.refreshSkills();
  assert.equal(windowListeners.focus, undefined);

  const stop = store.refreshSkillsOnFocus();
  windowListeners.focus();
  await settle();
  assert.deepEqual(
    [api.lists, store.useSkillsStore.getState().skills.map((entry) => entry.name)],
    [2, ["edited-outside"]]
  );

  stop();
  assert.equal(windowListeners.focus, undefined);
});

test("a refresh asked for during a load runs again once it finishes", async (t) => {
  let answer;
  const api = {
    lists: 0,
    skillsList: () => {
      api.lists += 1;
      return api.lists === 1
        ? new Promise((resolve) => {
            answer = () => resolve({ skills: [skill("stale")] });
          })
        : Promise.resolve({ skills: [skill("fresh")] });
    },
  };
  const { store } = await loadStore(t, api);

  const first = store.refreshSkills();
  const second = store.refreshSkills();
  answer();
  await Promise.all([first, second]);

  assert.equal(api.lists, 2);
  assert.deepEqual(
    store.useSkillsStore.getState().skills.map((entry) => entry.name),
    ["fresh"]
  );
});

test("a list that can't be read marks the load as failed", async (t) => {
  const { store } = await loadStore(t, {
    skillsList: async () => {
      throw new Error("EACCES");
    },
  });

  await store.refreshSkills();

  assert.deepEqual(
    [store.useSkillsStore.getState().loaded, store.useSkillsStore.getState().loadError],
    [false, true]
  );
});

test("a switch that fails resolves false and reloads the list", async (t) => {
  const api = Object.assign(libraryApi([[skill("recap", false)]]), {
    skillsSetEnabled: async (name) => {
      if (name === "locked") throw new Error("Error invoking remote method 'skills-set-enabled'");
      return { ok: false, error: "invalid" };
    },
  });
  const { store } = await loadStore(t, api);
  await store.refreshSkills();

  assert.equal(await store.setSkillEnabled("locked", true), false);
  assert.equal(await store.setSkillEnabled("recap", true), false);
  await settle();

  assert.equal(api.lists, 3);
  assert.equal(store.useSkillsStore.getState().skills[0].enabled, false);
});

test("switching on bumps the icon's play count and switching off doesn't", async (t) => {
  const switched = [];
  const api = {
    ...libraryApi([[skill("recap", false)]]),
    skillsSetEnabled: async (name, enabled) => {
      switched.push([name, enabled]);
      return name === "broken" ? { ok: false, error: "invalid" } : { ok: true };
    },
  };
  const { store } = await loadStore(t, api);
  await store.refreshSkills();
  const plays = () => store.useSkillsStore.getState().iconPlays.recap ?? 0;

  assert.equal(await store.setSkillEnabled("recap", true), true);
  assert.deepEqual(
    [store.useSkillsStore.getState().skills[0].enabled, plays()],
    [true, 1]
  );
  assert.equal(await store.setSkillEnabled("recap", false), true);
  assert.deepEqual(
    [store.useSkillsStore.getState().skills[0].enabled, plays()],
    [false, 1]
  );
  assert.equal(await store.setSkillEnabled("broken", true), false);
  assert.equal(store.useSkillsStore.getState().iconPlays.broken, undefined);

  store.playSkillIcon("recap");
  assert.equal(plays(), 2);
  assert.deepEqual(switched, [
    ["recap", true],
    ["recap", false],
    ["broken", true],
  ]);
});
