const test = require("node:test");
const assert = require("node:assert/strict");

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

// Only an older build writes these, so the tests seed the stored entry directly.
function seedPending(selections) {
  localStorage.setItem("pendingLocalModelSelectionsV1", JSON.stringify(selections));
}

test("pending local model selections remain isolated by scope", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  seedPending({
    dictation: { provider: "whisper", modelId: "base" },
    assistant: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
  });

  assert.deepEqual(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "unmanaged",
      policy: null,
      appVersion: "1.11.1",
    }),
    {
      provider: "whisper",
      modelId: "base",
    }
  );
  assert.equal(pending.hasPendingLocalModels(), true);
  assert.deepEqual(pending.readPendingLocalModels().assistant, {
    provider: "qwen",
    modelId: "qwen3.5-4b-q4_k_m",
  });
});

test("a completion cannot consume a different pending model", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  seedPending({ dictation: { provider: "whisper", modelId: "small" } });

  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "unmanaged",
      policy: null,
      appVersion: "1.11.1",
    }),
    null
  );
  assert.equal(pending.readPendingLocalModels().dictation.modelId, "small");
  pending.forgetPendingLocalModel("dictation", "small");
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("finishing onboarding drops every pending pick and the tray's flag", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  seedPending({
    dictation: { provider: "whisper", modelId: "base" },
    assistant: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
  });
  localStorage.setItem("localSetupPending", "true");
  pending.discardPendingLocalSetup();

  assert.deepEqual(pending.readPendingLocalModels(), {});
  assert.equal(pending.hasPendingLocalModels(), false);
  assert.equal(localStorage.getItem("localSetupPending"), null);
});

test("pending local model availability distinguishes active, installed, and orphaned models", async () => {
  global.localStorage = createStorage();
  const { getPendingLocalModelAvailability } =
    await import("../../src/components/onboarding/pendingLocalModels.ts");
  const dictation = { provider: "whisper", modelId: "base" };
  const assistant = { provider: "qwen", modelId: "qwen-local" };

  assert.equal(
    getPendingLocalModelAvailability("dictation", dictation, {
      whisper: [{ model: "base", downloaded: false, isDownloading: true }],
    }),
    "downloading"
  );
  assert.equal(
    getPendingLocalModelAvailability("assistant", assistant, {
      llm: [{ id: "qwen-local", isDownloaded: true, isDownloading: false }],
    }),
    "downloaded"
  );
  assert.equal(
    getPendingLocalModelAvailability("dictation", dictation, {
      whisper: [{ model: "base", downloaded: false, isDownloading: false }],
    }),
    "missing"
  );
  assert.equal(getPendingLocalModelAvailability("dictation", dictation, {}), "unknown");
});

test("local setup remembers a row still downloading and lets the tray apply it", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const cleanup = { provider: "qwen", modelId: "qwen3.5-2b-q4_k_m" };

  pending.rememberPendingLocalModel("cleanup", cleanup);

  assert.deepEqual(pending.readPendingLocalModels(), { cleanup });
  assert.equal(localStorage.getItem("localSetupPending"), "true");
  assert.equal(
    pending.getPendingLocalModelAvailability("cleanup", cleanup, {
      llm: [{ id: cleanup.modelId, isDownloaded: true }],
    }),
    "downloaded"
  );
});

test("pending activation checks current approvals without changing saved preferences", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const policy = {
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      transcription: { allowedModes: ["local"], allowedLocalModels: [] },
      minAppVersion: null,
    },
  };
  localStorage.setItem("whisperModel", "small");
  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });
  assert.equal(pending.consumePendingLocalModel("dictation", "base", policy), null);
  assert.equal(localStorage.getItem("whisperModel"), "small");
  assert.equal(pending.hasPendingLocalModels(), false);
  policy.policy.transcription.allowedLocalModels = ["base"];
  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });
  assert.deepEqual(pending.consumePendingLocalModel("dictation", "base", policy), {
    provider: "whisper",
    modelId: "base",
  });
});

test("pending activation cannot cross an account generation", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingLocalModel("dictation", {
    provider: "whisper",
    modelId: "base",
    accountId: "first",
    authGeneration: 4,
  });
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "unmanaged",
      policy: null,
      appVersion: "1.11.1",
      accountId: "second",
      authGeneration: 5,
    }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("Cohere pending inventory uses the shared native manager family", async () => {
  const { getPendingLocalModelAvailability } =
    await import("../../src/components/onboarding/pendingLocalModels.ts");
  assert.equal(
    getPendingLocalModelAvailability(
      "dictation",
      {
        provider: "cohere",
        modelId: "cohere-transcribe-03-2026",
      },
      { whisper: [], parakeet: [{ model: "cohere-transcribe-03-2026", downloaded: true }] }
    ),
    "downloaded"
  );
});

const APPROVED_BASE = {
  transcription: { allowedModes: ["local"], allowedLocalModels: ["base"] },
  minAppVersion: null,
};
const SELECTION = { provider: "whisper", modelId: "base", accountId: "first" };

for (const unresolved of [
  { status: "loading", accountId: "first", authGeneration: 5 },
  { status: "error", accountId: "first", authGeneration: 5 },
  // suspendPolicy and a relaunch before the first fetch both blank the account.
  { status: "loading", accountId: null, authGeneration: null },
  { status: "idle", accountId: null, authGeneration: null },
]) {
  test(`pending activation waits out ${unresolved.status} with account ${unresolved.accountId}`, async () => {
    global.localStorage = createStorage();
    const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
    pending.rememberPendingLocalModel("dictation", SELECTION);
    const snapshot = { ...unresolved, policy: null, appVersion: null };

    assert.equal(pending.consumePendingLocalModel("dictation", "base", snapshot), null);
    assert.deepEqual(pending.readPendingLocalModels().dictation, SELECTION);

    assert.deepEqual(
      pending.consumePendingLocalModel("dictation", "base", {
        status: "managed",
        appVersion: "1.11.1",
        policy: APPROVED_BASE,
        accountId: "first",
        authGeneration: 5,
      }),
      SELECTION
    );
    assert.equal(pending.hasPendingLocalModels(), false);
  });
}

test("a same-account token rotation does not drop a pending selection", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  // authGeneration is what an earlier build of this feature stored beside the account.
  const remembered = { ...SELECTION, authGeneration: 4 };
  pending.rememberPendingLocalModel("dictation", remembered);
  assert.deepEqual(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "managed",
      appVersion: "1.11.1",
      policy: APPROVED_BASE,
      accountId: "first",
      authGeneration: 5,
    }),
    remembered
  );
});

test("a settled denial after an unresolved completion drops the selection", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingLocalModel("dictation", SELECTION);
  const identity = { accountId: "first", authGeneration: 5 };
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "loading",
      policy: null,
      appVersion: null,
      ...identity,
    }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), true);
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "managed",
      appVersion: "1.11.1",
      policy: {
        ...APPROVED_BASE,
        transcription: { allowedModes: ["local"], allowedLocalModels: [] },
      },
      ...identity,
    }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("another account drops a pending selection even before its policy resolves", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingLocalModel("dictation", SELECTION);
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "loading",
      policy: null,
      appVersion: null,
      accountId: "second",
      authGeneration: 6,
    }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("a guest's pending selection activates without a policy", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const guest = { provider: "whisper", modelId: "base" };
  pending.rememberPendingLocalModel("dictation", guest);
  assert.deepEqual(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "idle",
      policy: null,
      appVersion: null,
      accountId: null,
      authGeneration: null,
    }),
    guest
  );
});

test("a guest who signs in keeps a pending selection until the new account's verdict settles", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const guest = { provider: "whisper", modelId: "base" };
  pending.rememberPendingLocalModel("dictation", guest);
  const signedIn = { policy: null, appVersion: null, accountId: "new", authGeneration: 7 };

  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", { ...signedIn, status: "loading" }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), true);

  assert.deepEqual(
    pending.consumePendingLocalModel("dictation", "base", { ...signedIn, status: "unmanaged" }),
    guest
  );
});

test("a guest's pending selection the new account's policy refuses is dropped", async () => {
  global.localStorage = createStorage();
  const { managedPolicy } = require("./harness/policyFixtures");
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });

  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "managed",
      policy: managedPolicy({
        transcription: { allowedModes: ["local"], allowedLocalModels: ["small"] },
      }),
      appVersion: "1.11.1",
      accountId: "new",
      authGeneration: 7,
    }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("a pending pick's verdict: unresolved waits, another account or a denial is final", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const selection = { provider: "qwen", modelId: "qwen3.5-2b-q4_k_m", accountId: "first" };
  const managed = (allowedLocalModels) => ({
    status: "managed",
    appVersion: "1.11.1",
    accountId: "first",
    policy: {
      llm: { allowedModes: ["local"], allowedLocalModels },
      minAppVersion: null,
    },
  });
  const judge = (policy) => pending.judgePendingLocalModel("cleanup", selection, policy);

  assert.equal(judge({ status: "loading", accountId: "first" }), "unresolved");
  assert.equal(judge({ status: "unmanaged", accountId: null }), "unresolved");
  assert.equal(judge({ status: "unmanaged", accountId: "second" }), "denied");
  assert.equal(judge(managed(["qwen3.5-2b-q4_k_m"])), "allowed");
  assert.equal(judge(managed(["qwen3.5-4b-q4_k_m"])), "denied", "cleanup is an LLM pick");
});

test("failed background downloads count per model, and Retry starts over", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  seedPending({
    cleanup: { provider: "qwen", modelId: "a" },
    assistant: { provider: "qwen", modelId: "b" },
  });

  pending.recordPendingLocalModelFailure("a");
  pending.recordPendingLocalModelFailure("a");
  assert.equal(pending.readPendingLocalModels().cleanup.failedAttempts, 2);
  assert.equal(pending.readPendingLocalModels().assistant.failedAttempts, undefined);

  pending.clearPendingLocalModelFailures("a");
  assert.equal(pending.readPendingLocalModels().cleanup.failedAttempts, undefined);
  assert.equal(pending.isPendingLocalModel("a"), true);

  pending.forgetPendingLocalModelById("a");
  assert.equal(pending.isPendingLocalModel("a"), false);
});

test("a graphics pack that keeps failing is given up on", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingGraphicsPack();
  assert.equal(pending.hasPendingLocalModels(), true);
  assert.equal(localStorage.getItem("localSetupPending"), "true");
  for (let attempt = 1; attempt < pending.MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS; attempt++) {
    pending.recordPendingGraphicsPackFailure();
    assert.equal(pending.hasPendingGraphicsPack(), true);
  }
  pending.recordPendingGraphicsPackFailure();
  assert.equal(pending.hasPendingGraphicsPack(), false);

  pending.rememberPendingGraphicsPack();
  pending.discardPendingLocalSetup();
  assert.equal(pending.hasPendingGraphicsPack(), false);
});

test("chat only says the assistant is on its way while a text model is really downloading", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const withActive = (active) => {
    global.window = { electronAPI: { modelGetActiveDownloads: async () => active } };
  };

  withActive([{ modelType: "llm", modelId: "cleanup-model" }]);
  assert.equal(await pending.isPendingAssistantModelDownloading(), false, "nothing pending");

  seedPending({ assistant: { provider: "qwen", modelId: "assistant-model" } });
  assert.equal(await pending.isPendingAssistantModelDownloading(), true, "queued behind cleanup");
  withActive([{ modelType: "parakeet", modelId: "speech" }]);
  assert.equal(await pending.isPendingAssistantModelDownloading(), false, "its download failed");
  delete global.window;
});
