const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/noteFormattingOverrides.js");

test("self-hosted forwards remoteUrl as lanUrl and the api key (regression: was hitting OpenAI)", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides(
    { mode: "self-hosted", remoteUrl: "http://192.168.1.126:11434/v1", model: "llama3" },
    "sk-local"
  );
  assert.equal(overrides.lanUrl, "http://192.168.1.126:11434/v1");
  assert.equal(overrides.customApiKey, "sk-local");
  assert.equal(overrides.provider, undefined);
  assert.equal(overrides.baseUrl, undefined);
});

test("self-hosted with no key still routes via lanUrl", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides(
    { mode: "self-hosted", remoteUrl: "http://host:8080/v1" },
    ""
  );
  assert.equal(overrides.lanUrl, "http://host:8080/v1");
  assert.equal(overrides.customApiKey, undefined);
});

test("providers/custom forwards cloudBaseUrl as baseUrl and the key", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides(
    { mode: "providers", provider: "custom", cloudBaseUrl: "https://api.example.com/v1" },
    "sk-custom"
  );
  assert.deepEqual(overrides, {
    provider: "custom",
    baseUrl: "https://api.example.com/v1",
    customApiKey: "sk-custom",
    lanUrl: undefined,
  });
});

test("providers with a first-party cloud provider passes provider only, no key/baseUrl", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides(
    { mode: "providers", provider: "anthropic" },
    "should-not-leak"
  );
  assert.deepEqual(overrides, {
    provider: "anthropic",
    baseUrl: undefined,
    customApiKey: undefined,
    lanUrl: undefined,
  });
});

test("local mode passes no provider overrides (uses model-derived local provider)", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides(
    { mode: "local", model: "qwen2.5-3b" },
    "irrelevant"
  );
  assert.deepEqual(overrides, {
    provider: undefined,
    baseUrl: undefined,
    customApiKey: undefined,
    lanUrl: undefined,
  });
});
