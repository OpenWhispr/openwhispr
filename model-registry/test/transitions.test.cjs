const test = require("node:test");
const assert = require("node:assert/strict");
const { assertCompatibleCatalog, capabilityChanges } = require("../lib/schema.cjs");
const { readCatalog } = require("../lib/catalog.cjs");
const seed = require("./seed.json");

const base = readCatalog();
const provider = (data, section, id) => data[section].find((p) => p.id === id);
const model = (data, section, providerId, modelId) =>
  provider(data, section, providerId).models.find((m) => m.id === modelId);
const edit = (change, from = base) => {
  const data = structuredClone(from);
  change(data);
  return data;
};
const pinned = (repo, commit, file) => `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

test("the reseeded catalog keeps every shipped model", () => {
  assert.doesNotThrow(() => assertCompatibleCatalog(base, seed, { floor: seed }));
});

test("a shut-down model is retired in one data change, never deleted", () => {
  const retired = edit((data) =>
    Object.assign(model(data, "cloudProviders", "openai", "gpt-5.5"), {
      retired: true,
      replacement: "gpt-6-luna",
    })
  );
  assert.doesNotThrow(() => assertCompatibleCatalog(retired, base));
  const deleted = edit((data) => {
    const openai = provider(data, "cloudProviders", "openai");
    openai.models = openai.models.filter((m) => m.id !== "gpt-5.5");
  });
  assert.throws(() => assertCompatibleCatalog(deleted, base), /retire it instead/);
  const revived = edit((data) => {
    const entry = model(data, "cloudProviders", "openai", "gpt-5.5");
    delete entry.retired;
    delete entry.replacement;
  }, retired);
  assert.throws(() => assertCompatibleCatalog(revived, retired), /cannot be un-retired/);
  const whisper = edit((data) => (data.whisperModels.medium.retired = true));
  assert.doesNotThrow(() => assertCompatibleCatalog(whisper, base));
  delete whisper.whisperModels.medium;
  assert.throws(() => assertCompatibleCatalog(whisper, base), /retire it instead/);
});

test("legacy can be set and cleared on published models", () => {
  const legacy = edit((data) => (model(data, "cloudProviders", "openai", "gpt-5.5").legacy = true));
  assert.doesNotThrow(() => assertCompatibleCatalog(legacy, base));
  assert.doesNotThrow(() => assertCompatibleCatalog(base, legacy));
});

test("defaults and display order are editable", () => {
  const next = edit((data) => {
    const openai = provider(data, "cloudProviders", "openai");
    openai.models.reverse();
    openai.defaultModel = "gpt-6-luna";
    provider(data, "transcriptionProviders", "assemblyai").models.reverse();
  });
  assert.doesNotThrow(() => assertCompatibleCatalog(next, base));
});

test("providers, endpoints, transports and version floors stay fixed", () => {
  for (const [change, message] of [
    [(data) => data.cloudProviders.reverse(), /Changed providers/],
    [(data) => data.cloudProviders.push({ id: "new", name: "New", models: [] }), /Changed providers/],
    [
      (data) => (data.transcriptionProviders[0].baseUrl = "https://attacker.example/v1"),
      /provider contract/,
    ],
    [(data) => (data.cloudProviders[0].keyId = "anthropic"), /Unrecognized/],
    [
      (data) => (model(data, "transcriptionProviders", "openai", "gpt-transcribe").streaming = true),
      /transcription transport/,
    ],
    [
      (data) => (model(data, "cloudProviders", "openai", "gpt-5.5").minAppVersion = "9.0.0"),
      /minimum app version/,
    ],
    [(data) => (data.diarizationModels.extra = {}), /legacy section/],
  ])
    assert.throws(() => assertCompatibleCatalog(edit(change), base), message);
});

test("new transcription models need an adapter that selects models and supports their transport", () => {
  for (const providerId of ["xai", "corti"]) {
    const next = edit((data) => {
      const entry = provider(data, "transcriptionProviders", providerId);
      entry.models.push({ ...entry.models[0], id: `${providerId}-new` });
    });
    assert.throws(() => assertCompatibleCatalog(next, base), /does not support model selection/);
  }
  const live = edit((data) =>
    provider(data, "transcriptionProviders", "groq").models.push({
      id: "groq-live",
      name: "Live",
      description: "Fixture",
      streaming: true,
    })
  );
  assert.throws(() => assertCompatibleCatalog(live, base), /Unsupported streaming provider/);
});

test("Whisper files move while their hash vouches for the bytes", () => {
  const hashed = edit((data) => (data.whisperModels.base.sha256 = "a".repeat(64)));
  assert.doesNotThrow(() => assertCompatibleCatalog(hashed, base), "adding a hash is allowed");
  const moved = edit(
    (data) =>
      (data.whisperModels.base.downloadUrl = pinned(
        "ggml-org/whisper.cpp",
        "c".repeat(40),
        "ggml-base.bin"
      )),
    hashed
  );
  assert.doesNotThrow(() => assertCompatibleCatalog(moved, hashed));
  const unhashedMove = edit(
    (data) =>
      (data.whisperModels.base.downloadUrl = pinned("ggml-org/whisper.cpp", "c".repeat(40), "ggml-base.bin"))
  );
  assert.throws(() => assertCompatibleCatalog(unhashedMove, base), /only move once sha256 is set/);
  const both = edit((data) => (data.whisperModels.base.sha256 = "b".repeat(64)), moved);
  assert.throws(() => assertCompatibleCatalog(both, hashed), /new model ID/);
  const unpinnedMove = edit(
    (data) =>
      (data.whisperModels.base.downloadUrl =
        "https://huggingface.co/ggml-org/whisper.cpp/resolve/main/ggml-base.bin"),
    hashed
  );
  assert.throws(() => assertCompatibleCatalog(unpinnedMove, hashed), /pinned revision/);
});

test("a wrong hash is corrected only at a pinned location", () => {
  const unpinned = edit((data) => (data.whisperModels.base.sha256 = "a".repeat(64)));
  const correction = edit((data) => (data.whisperModels.base.sha256 = "b".repeat(64)), unpinned);
  assert.throws(() => assertCompatibleCatalog(correction, unpinned), /pinned revision/);
  const atCommit = edit((data) => {
    data.whisperModels.base.downloadUrl = pinned("ggerganov/whisper.cpp", "d".repeat(40), "ggml-base.bin");
  }, unpinned);
  const fixed = edit((data) => (data.whisperModels.base.sha256 = "b".repeat(64)), atCommit);
  assert.doesNotThrow(() => assertCompatibleCatalog(fixed, atCommit));
  const removed = edit((data) => delete data.whisperModels.base.sha256, atCommit);
  assert.throws(() => assertCompatibleCatalog(removed, atCommit), /Removed artifact digest/);
});

test("GGUF artifacts follow the same one-leg rule and keep their identity", () => {
  const [first] = base.localProviders[0].models;
  const published = edit((data) =>
    data.localProviders[0].models.push({
      ...structuredClone(first),
      id: "new-local",
      fileName: "new-local.gguf",
      revision: "a".repeat(40),
      sha256: "b".repeat(64),
      draftHfRepo: undefined,
      draftFileName: undefined,
      draftSizeBytes: undefined,
      draftSha256: undefined,
      draftRevision: undefined,
    })
  );
  for (const entry of published.localProviders[0].models)
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
  assert.doesNotThrow(() => assertCompatibleCatalog(published, base));
  const local = (data) => data.localProviders[0].models.at(-1);
  const corrected = edit((data) => (local(data).sha256 = "c".repeat(64)), published);
  assert.doesNotThrow(() => assertCompatibleCatalog(corrected, published));
  const moved = edit((data) => (local(data).hfRepo = "mirror/new-local"), published);
  assert.doesNotThrow(() => assertCompatibleCatalog(moved, published));
  const both = edit((data) => {
    local(data).revision = "d".repeat(40);
    local(data).sha256 = "e".repeat(64);
  }, published);
  assert.throws(() => assertCompatibleCatalog(both, published), /new model ID/);
  for (const field of ["fileName", "quantization", "contextLength"]) {
    const changed = edit(
      (data) => (local(data)[field] = field === "contextLength" ? 1024 : "other.gguf"),
      published
    );
    assert.throws(() => assertCompatibleCatalog(changed, published), /identity/, field);
  }
});

test("new downloads need hashes and pinned revisions unless the app already ships them", () => {
  const [first] = base.localProviders[0].models;
  const fresh = {
    ...structuredClone(first),
    id: "brand-new",
    fileName: "brand-new.gguf",
  };
  for (const key of ["draftHfRepo", "draftFileName", "draftSizeBytes", "draftSha256", "draftRevision", "sha256", "revision"])
    delete fresh[key];
  const unhashed = edit((data) => data.localProviders[0].models.push(fresh));
  assert.throws(() => assertCompatibleCatalog(unhashed, base), /requires sha256/);
  const unpinned = edit((data) => (data.localProviders[0].models.at(-1).sha256 = "a".repeat(64)), unhashed);
  assert.throws(() => assertCompatibleCatalog(unpinned, base), /pinned revision/);
  const ready = edit((data) => (data.localProviders[0].models.at(-1).revision = "b".repeat(40)), unpinned);
  assert.doesNotThrow(() => assertCompatibleCatalog(ready, base));
  assert.doesNotThrow(
    () => assertCompatibleCatalog(unhashed, base, { floor: unhashed }),
    "an entry the app bundles was reviewed there"
  );
  const parakeet = edit(
    (data) =>
      (data.parakeetModels["new-parakeet"] = {
        ...structuredClone(data.parakeetModels["parakeet-tdt-0.6b-v3"]),
        runtime: "online",
        modelType: "cohere-transcribe",
        sha256: "a".repeat(64),
        downloadUrl: pinned("org/repo", "a".repeat(40), "model.tar.bz2"),
      })
  );
  delete parakeet.parakeetModels["new-parakeet"].sherpaModelType;
  delete parakeet.parakeetModels["new-parakeet"].manifestUrl;
  assert.throws(() => assertCompatibleCatalog(parakeet, base), /engine combination/);
});

test("request-setting changes on published models are reported for a maintainer label", () => {
  const next = edit((data) => {
    const entry = model(data, "cloudProviders", "openai", "gpt-5.5");
    entry.supportsTemperature = !entry.supportsTemperature;
    delete entry.reasoningEffort;
    model(data, "cloudProviders", "openai", "gpt-5.2").description = "Copy edit only";
  });
  assert.deepEqual(capabilityChanges(next, base), [
    {
      section: "cloudProviders",
      provider: "openai",
      id: "gpt-5.5",
      fields: ["supportsTemperature", "reasoningEffort"],
    },
  ]);
  assert.deepEqual(capabilityChanges(base, base), []);
});
