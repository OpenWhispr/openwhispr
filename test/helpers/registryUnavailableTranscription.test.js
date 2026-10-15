const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");

function history(t, provider, model) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => JSON.stringify([JSON.stringify(["transcriptionProviders", provider, model])]),
    },
  });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, "localStorage", old);
    else delete globalThis.localStorage;
  });
}

const settings = {
  transcriptionMode: "providers",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "future-published-stt",
};

test("missing published batch selection fails explicitly even if the caller supplied a fallback", async (t) => {
  history(t, "openai", settings.cloudTranscriptionModel);
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");
  const route = resolveTranscriptionRoute({ settings, request: { model: "gpt-transcribe" } });
  assert.equal(route.transport, "error");
  assert.equal(route.code, "MODEL_CATALOG_UNAVAILABLE");
  assert.equal(route.messageKey, "onboarding.rehaul.provider.errors.modelNotFound");
  assert.equal(route.endpoint, undefined);
});

test("verified catalog recovery restores the exact published model; unknown legacy IDs keep their default", async (t) => {
  history(t, "openai", settings.cloudTranscriptionModel);
  const store = await import("../../src/models/registryData.js");
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");
  const old = store.getRegistrySnapshot();
  const data = structuredClone(seed);
  data.transcriptionProviders
    .find((p) => p.id === "openai")
    .models.push({ id: settings.cloudTranscriptionModel, name: "Future", description: "Future" });
  store.replaceRegistryData({ data, manifestVersion: old.manifestVersion + 1 });
  t.after(() =>
    store.replaceRegistryData({ data: old.data, manifestVersion: old.manifestVersion + 2 })
  );
  assert.equal(resolveTranscriptionRoute({ settings }).model, settings.cloudTranscriptionModel);
  assert.equal(
    resolveTranscriptionRoute({
      settings: { ...settings, cloudTranscriptionModel: "legacy-unknown" },
    }).model,
    "gpt-transcribe"
  );
});

test("organization denial outranks unavailable model history", async (t) => {
  history(t, "openai", settings.cloudTranscriptionModel);
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");
  const policy = {
    status: "managed",
    appVersion: "1.8.2",
    policy: { version: 1, transcription: { allowedModes: ["local"], allowedByokProviders: [] } },
  };
  assert.equal(resolveTranscriptionRoute({ settings, policy }).code, "POLICY_RESTRICTED");
});

test("meeting selection never substitutes another model while a published selection is unavailable", async (t) => {
  history(t, "openai", settings.cloudTranscriptionModel);
  const { resolveMeetingTranscriptionOptions } =
    await import("../../src/helpers/meetingTranscriptionRouting.js");
  const options = {
    transcriptionMode: "providers",
    selectedProvider: "openai",
    selectedModel: settings.cloudTranscriptionModel,
    byokProviders: [{ id: "openai", models: [{ id: "gpt-4o-mini-transcribe" }] }],
  };
  assert.throws(() => resolveMeetingTranscriptionOptions(options), {
    message: "publishedModelUnavailable",
  });
  assert.equal(
    resolveMeetingTranscriptionOptions({ ...options, selectedModel: "legacy-unknown" }).model,
    "gpt-4o-mini-transcribe"
  );
  assert.equal(
    resolveMeetingTranscriptionOptions({ ...options, transcriptionMode: "openwhispr" }).mode,
    "openwhispr"
  );
});

test("meeting unavailable sentinel uses an existing localized model error", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const mount = fs.readFileSync(
    path.join(__dirname, "../../src/components/MeetingRecordingMount.tsx"),
    "utf8"
  );
  assert.match(
    mount,
    /publishedModelUnavailable: "onboarding\.rehaul\.provider\.errors\.modelNotFound"/
  );
  const translation = require("../../src/locales/en/translation.json");
  assert.equal(typeof translation.onboarding.rehaul.provider.errors.modelNotFound, "string");
});
