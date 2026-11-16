const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/dictionaryTool.ts");

function harness(words, sharedWords = []) {
  const calls = [];
  const hideCalls = [];
  return {
    calls,
    hideCalls,
    actions: {
      getDictionary: () => words,
      updateDictionary: (changes) => calls.push(changes),
      getSharedWords: async () => sharedWords.map((word) => ({ reachesPrompt: true, ...word })),
      hideSharedWords: async (ids) => {
        hideCalls.push(ids);
      },
    },
  };
}

test("adds new words and removes existing ones case-insensitively in one call", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr", "Parakeat"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: [" Parakeet ", "Orukeet"], remove: ["parakeat"] });

  assert.deepEqual(calls, [{ add: ["Parakeet", "Orukeet"], remove: ["Parakeat"] }]);
  assert.deepEqual(result, {
    success: true,
    data: {
      added: ["Parakeet", "Orukeet"],
      removed: ["Parakeat"],
      hidden: [],
      alreadyPresent: [],
      notFound: [],
    },
    displayText: 'Added "Parakeet", "Orukeet"; Removed "Parakeat"',
  });
});

function promptHarness(sharedWords, personalWords = [], snippets = []) {
  const {
    selectAppliedSharedWords,
    selectSharedHintWords,
  } = require("../../src/utils/sharedDictionaryHints.ts");
  const snapshot = {
    entries: sharedWords.map((word, index) => ({
      cloudId: `shared-${index}`,
      spaceId: null,
      word,
      addedByUserId: null,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    })),
    hiddenIds: [],
    meta: {
      scopes: [
        { space_id: null, name: "Workspace", member_count: 2, word_count: sharedWords.length },
      ],
      contributors: [],
      paused: false,
      syncedAt: "2026-10-20T00:00:00.000Z",
    },
  };
  const settings = {
    customDictionary: personalWords,
    snippets,
    sharedDictionaryHints: selectSharedHintWords(snapshot),
  };
  const state = harness(personalWords);
  state.actions.getSharedWords = async () => selectAppliedSharedWords(snapshot, settings);
  return { ...state, settings };
}

test("a shared word excluded by all prompt caps can be added to Personal", async () => {
  const { createUpdateDictionaryTool } = await load();
  const {
    getKeytermDictionaryWords,
    getKeywordDictionaryWords,
    getLlmDictionaryWords,
  } = require("../../src/utils/snippets.ts");
  const words = [...Array.from({ length: 200 }, (_, index) => `Term${index}`), "Tailword"];
  const { actions, calls, settings } = promptHarness(words);
  assert.equal(getKeytermDictionaryWords(settings).includes("Tailword"), false);
  assert.equal(getKeywordDictionaryWords(settings).includes("Tailword"), false);
  assert.equal(
    getLlmDictionaryWords(settings, { includeTriggers: true }).includes("Tailword"),
    false
  );
  assert.equal(
    getLlmDictionaryWords(settings, { includeTriggers: false }).includes("Tailword"),
    false
  );

  const result = await createUpdateDictionaryTool(actions).execute({ add: ["Tailword"] });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ add: ["Tailword"], remove: [] }]);
});

test("a shared word excluded by the character cap can be added to Personal", async () => {
  const { createUpdateDictionaryTool } = await load();
  const words = [
    ...Array.from({ length: 100 }, (_, index) => `Term${index}${"x".repeat(40)}`),
    "Tailword",
  ];
  const { actions, calls } = promptHarness(words);
  const result = await createUpdateDictionaryTool(actions).execute({ add: ["Tailword"] });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ add: ["Tailword"], remove: [] }]);
});

test("shared words reaching either STT or LLM still count as already present", async () => {
  const { createUpdateDictionaryTool } = await load();
  const {
    getKeywordDictionaryWords,
    getLlmDictionaryWords,
  } = require("../../src/utils/snippets.ts");
  for (const [words, target, inStt, inLlm] of [
    [Array.from({ length: 150 }, (_, index) => `Term${index}`), "Term149", false, true],
    [
      Array.from({ length: 80 }, (_, index) => `Term${index}${"x".repeat(40)}`),
      `Term79${"x".repeat(40)}`,
      true,
      false,
    ],
  ]) {
    const { actions, calls, settings } = promptHarness(words);
    assert.equal(getKeywordDictionaryWords(settings).includes(target), inStt);
    assert.equal(
      getLlmDictionaryWords(settings, { includeTriggers: true }).includes(target),
      inLlm
    );
    const result = await createUpdateDictionaryTool(actions).execute({ add: [target] });
    assert.equal(result.success, false);
    assert.deepEqual(calls, []);
    assert.match(result.displayText, /Already in the dictionary/);
  }
});

test("removing a cap-excluded shared word still hides every shared copy", async () => {
  const { createUpdateDictionaryTool } = await load();
  const words = [
    ...Array.from({ length: 200 }, (_, index) => `Term${index}`),
    "Tailword",
    "TAILWORD",
  ];
  const { actions, hideCalls } = promptHarness(words);
  const result = await createUpdateDictionaryTool(actions).execute({ remove: ["tailword"] });
  assert.equal(result.success, true);
  assert.deepEqual(hideCalls, [["shared-200", "shared-201"]]);
});

test("a shared word reaching only the keyterm path still counts as present", async () => {
  const { createUpdateDictionaryTool } = await load();
  const {
    getKeytermDictionaryWords,
    getKeywordDictionaryWords,
    getLlmDictionaryWords,
  } = require("../../src/utils/snippets.ts");
  const words = [
    ...Array.from({ length: 100 }, (_, index) => `Term${index}${"x".repeat(50)}`),
    "Tailword",
  ];
  const { actions, calls, settings } = promptHarness(words);
  assert.equal(getKeytermDictionaryWords(settings).includes("Tailword"), true);
  assert.equal(getKeywordDictionaryWords(settings).includes("Tailword"), false);
  assert.equal(
    getLlmDictionaryWords(settings, { includeTriggers: true }).includes("Tailword"),
    false
  );
  const result = await createUpdateDictionaryTool(actions).execute({ add: ["Tailword"] });
  assert.equal(result.success, false);
  assert.deepEqual(calls, []);
  assert.match(result.displayText, /Already in the dictionary/);
});

test("words already present are reported instead of re-added", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["openwhispr"] });

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.displayText, 'Already in the dictionary: "openwhispr"');
});

test("removing a word that is not there fails without writing", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["Whisper"] });

  assert.equal(calls.length, 0);
  assert.deepEqual(result, {
    success: false,
    data: null,
    displayText: 'Not in the dictionary: "Whisper"',
  });
});

test("the tool is a write tool", async () => {
  const { createUpdateDictionaryTool } = await load();
  const tool = createUpdateDictionaryTool(harness([]).actions);
  assert.equal(tool.name, "update_dictionary");
  assert.equal(tool.readOnly, false);
});

test("removing a shared word hides it and never deletes", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls, hideCalls } = harness(
    ["OpenWhispr"],
    [
      { id: "entry-1", word: "Kubernetes" },
      { id: "entry-2", word: "kubernetes" },
    ]
  );
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["KUBERNETES"] });

  assert.deepEqual(hideCalls, [["entry-1", "entry-2"]]);
  assert.equal(calls.length, 0);
  assert.equal(result.success, true);
  assert.deepEqual(result.data.hidden, ["KUBERNETES"]);
  assert.deepEqual(result.data.removed, []);
  assert.match(result.displayText, /Hidden for you "KUBERNETES"/);
});

test("a spelling fix hides the shared word and adds the corrected one to Personal", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls, hideCalls } = harness([], [{ id: "entry-1", word: "Parakeat" }]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["Parakeet"], remove: ["Parakeat"] });

  assert.deepEqual(hideCalls, [["entry-1"]]);
  assert.deepEqual(calls, [{ add: ["Parakeet"], remove: [] }]);
  assert.equal(result.success, true);
});

test("a word only in Personal is removed without hiding anything", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls, hideCalls } = harness(["Orukeet"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["orukeet"] });

  assert.deepEqual(calls, [{ add: [], remove: ["Orukeet"] }]);
  assert.equal(hideCalls.length, 0);
  assert.deepEqual(result.data.removed, ["Orukeet"]);
  assert.deepEqual(result.data.hidden, []);
});

test("a word in Personal and a shared list is removed and its shared copy hidden", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls, hideCalls } = harness(["Orukeet"], [{ id: "entry-1", word: "Orukeet" }]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["orukeet"] });

  assert.deepEqual(hideCalls, [["entry-1"]]);
  assert.deepEqual(calls, [{ add: [], remove: ["Orukeet"] }]);
  assert.deepEqual(result.data.removed, ["Orukeet"]);
  assert.deepEqual(result.data.hidden, ["orukeet"]);
  assert.equal(result.displayText, 'Removed "Orukeet" and hid the shared copy for you');
});

test("adding a word that is shared reports alreadyPresent", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls, hideCalls } = harness([], [{ id: "entry-1", word: "Kubernetes" }]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["kubernetes"] });

  assert.equal(calls.length, 0);
  assert.equal(hideCalls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.displayText, 'Already in the dictionary: "kubernetes"');
});

test("a failed hide changes nothing and reports the failure", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["Old"], [{ id: "entry-1", word: "Kubernetes" }]);
  actions.hideSharedWords = async () => {
    throw new Error("offline");
  };
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["New"], remove: ["Old", "Kubernetes"] });

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.match(result.displayText, /Could not hide "Kubernetes"/);
});

test("a partly applied hide says some words were hidden and skips the Personal write", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["Old"], [{ id: "entry-1", word: "Kubernetes" }]);
  actions.hideSharedWords = async () => {
    throw Object.assign(new Error("offline"), { appliedCount: 1 });
  };
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["Old", "Kubernetes"] });

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.doesNotMatch(result.displayText, /Nothing was changed/);
  assert.match(result.displayText, /Some were hidden/);
});

test("a case-only respelling of a shared word hides it and adds the new spelling", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls, hideCalls } = harness([], [{ id: "entry-1", word: "Acme" }]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["Acme"], add: ["ACME"] });

  assert.deepEqual(hideCalls, [["entry-1"]]);
  assert.deepEqual(calls, [{ add: ["ACME"], remove: [] }]);
  assert.equal(result.success, true);
  assert.deepEqual(result.data.added, ["ACME"]);
  assert.deepEqual(result.data.alreadyPresent, []);
});

test("a case-only respelling of a personal word removes it and adds the new spelling", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["Acme"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["Acme"], add: ["ACME"] });

  assert.deepEqual(calls, [{ add: ["ACME"], remove: ["Acme"] }]);
  assert.equal(result.success, true);
});

test("words match on NFC-normalised keys", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["Café"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["CAFÉ"] });

  assert.equal(calls.length, 0);
  assert.equal(result.displayText, 'Already in the dictionary: "CAFÉ"');
});

test("a removal names the stored spelling, so an NFD-stored word is really removed", async () => {
  const { createUpdateDictionaryTool } = await load();
  const stored = "Cafe\u0301";
  const { actions, calls } = harness([stored, "Other"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["caf\u00E9"] });

  assert.deepEqual(calls, [{ add: [], remove: [stored] }]);
  assert.deepEqual(result.data.removed, [stored]);
  // The store matches removals by toLowerCase, which the stored spelling satisfies.
  assert.ok(
    calls[0].remove.every((word) =>
      [stored].map((w) => w.toLowerCase()).includes(word.toLowerCase())
    )
  );
});
