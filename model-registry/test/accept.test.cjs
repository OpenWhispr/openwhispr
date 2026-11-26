const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptCatalog, contractId } = require("../lib/schema.cjs");
const { readCatalog } = require("../lib/catalog.cjs");
const seed = require("./seed.json");

const base = readCatalog();
const openai = (data) => data.cloudProviders.find((p) => p.id === "openai");
const ids = (data) => openai(data).models.map((m) => m.id);
const edit = (change) => {
  const data = structuredClone(base);
  change(data);
  return data;
};

test("a field added after this app shipped is dropped, not fatal", () => {
  const next = edit((data) => {
    openai(data).models[0].futureCapability = { mode: "turbo" };
    data.futureSection = [{ id: "x" }];
  });
  const accepted = acceptCatalog(next, seed, "1.12.0");
  assert.deepEqual(ids(accepted), ids(base));
  assert.equal(openai(accepted).models[0].futureCapability, undefined);
  assert.equal(accepted.futureSection, undefined);
});

test("an entry this app cannot read is skipped alone and the bundled copy stands in", () => {
  const next = edit((data) => {
    openai(data).models.find((m) => m.id === "gpt-5.5").tokenParam = "max_output_tokens";
    openai(data).models.push({ id: "unreadable", name: "x", description: "y", tokenParam: "z" });
  });
  const accepted = acceptCatalog(next, seed, "1.12.0");
  const shipped = openai(seed).models.find((m) => m.id === "gpt-5.5");
  assert.deepEqual(openai(accepted).models.find((m) => m.id === "gpt-5.5"), shipped);
  assert.equal(ids(accepted).includes("unreadable"), false);
  assert.ok(ids(accepted).length >= openai(seed).models.length);
});

test("bundled models and providers survive a catalog that omits them", () => {
  const next = edit((data) => {
    openai(data).models = openai(data).models.slice(0, 2);
    data.cloudProviders = data.cloudProviders.filter((p) => p.id !== "anthropic");
    delete data.whisperModels.base;
  });
  const accepted = acceptCatalog(next, seed, "1.12.0");
  for (const id of openai(seed).models.map((m) => m.id)) assert.ok(ids(accepted).includes(id), id);
  assert.ok(accepted.cloudProviders.some((p) => p.id === "anthropic"));
  assert.ok(accepted.whisperModels.base);
});

test("provider endpoints and membership come from the app, never from data", () => {
  const next = edit((data) => {
    data.transcriptionProviders[0].baseUrl = "https://attacker.example/v1";
    data.cloudProviders.push({ id: "rogue", name: "Rogue", defaultModel: "m", models: [] });
  });
  const accepted = acceptCatalog(next, seed, "1.12.0");
  assert.equal(accepted.transcriptionProviders[0].baseUrl, seed.transcriptionProviders[0].baseUrl);
  assert.equal(accepted.cloudProviders.some((p) => p.id === "rogue"), false);
});

test("defaults fall back to an active model and dangling replacements are dropped", () => {
  const next = edit((data) => {
    openai(data).defaultModel = "missing";
    Object.assign(openai(data).models.find((m) => m.id === "gpt-5.5"), {
      retired: true,
      replacement: "missing",
    });
  });
  const accepted = acceptCatalog(next, seed, "1.12.0");
  const fallback = openai(accepted).models.find((m) => m.id === openai(accepted).defaultModel);
  assert.ok(fallback && !fallback.retired && !fallback.legacy);
  const retired = openai(accepted).models.find((m) => m.id === "gpt-5.5");
  assert.equal(retired.retired, true);
  assert.equal(retired.replacement, undefined);
});

test("garbage never throws and yields the bundled catalog", () => {
  for (const input of [null, 42, "catalog", [], { cloudProviders: "x", whisperModels: [] }]) {
    const accepted = acceptCatalog(input, seed, "1.12.0");
    assert.deepEqual(ids(accepted), openai(seed).models.map((m) => m.id));
  }
  assert.doesNotThrow(() => acceptCatalog(JSON.parse('{"__proto__":{"x":1}}'), seed, "1.12.0"));
});

test("a malformed bundle is used as shipped rather than failing the app", () => {
  const broken = { ...structuredClone(seed), cloudProviders: "broken" };
  assert.deepEqual(acceptCatalog(base, broken, "1.12.0"), broken);
});

test("contract IDs are stable and change with any reader file", () => {
  const hashes = { schema: "a".repeat(64), envelope: "b".repeat(64), selection: "c".repeat(64) };
  assert.equal(contractId(hashes), contractId({ ...hashes }));
  assert.notEqual(contractId(hashes), contractId({ ...hashes, selection: "d".repeat(64) }));
  assert.match(contractId(hashes), /^[a-f0-9]{64}$/);
});

test("Whisper and Parakeet additions, edits and retirements reach the app", () => {
  const next = structuredClone(base);
  next.whisperModels["remote-whisper"] = {
    ...structuredClone(next.whisperModels.base),
    name: "Remote Whisper",
    fileName: "ggml-remote.bin",
  };
  next.whisperModels.small.description = "Edited";
  const [parakeetId] = Object.keys(next.parakeetModels);
  next.parakeetModels[parakeetId].retired = true;
  delete next.parakeetModels[parakeetId].legacy;
  const accepted = acceptCatalog(next, seed, "1.12.0");
  assert.equal(accepted.whisperModels["remote-whisper"].name, "Remote Whisper");
  assert.equal(accepted.whisperModels.small.description, "Edited");
  assert.equal(accepted.parakeetModels[parakeetId].retired, true);
  next.whisperModels["../escape"] = structuredClone(next.whisperModels.base);
  assert.equal(acceptCatalog(next, seed, "1.12.0").whisperModels["../escape"], undefined);
});
