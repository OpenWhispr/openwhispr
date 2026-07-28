const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/config/constants.ts");

test("bare origin falls back to /v1 (LM Studio, Ollama, vLLM)", async () => {
  const { getModelListBaseCandidates } = await load();

  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234"), [
    "http://127.0.0.1:1234",
    "http://127.0.0.1:1234/v1",
  ]);
});

test("LM Studio native REST bases fall back to the OpenAI-compatible /v1", async () => {
  const { getModelListBaseCandidates } = await load();

  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234/api/v1"), [
    "http://127.0.0.1:1234/api/v1",
    "http://127.0.0.1:1234/v1",
  ]);
  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234/api/v0"), [
    "http://127.0.0.1:1234/api/v0",
    "http://127.0.0.1:1234/v1",
  ]);
});

test("bases already ending in /v1 have no fallback", async () => {
  const { getModelListBaseCandidates } = await load();

  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234/v1"), [
    "http://127.0.0.1:1234/v1",
  ]);
  assert.deepEqual(getModelListBaseCandidates("https://api.together.xyz/v1"), [
    "https://api.together.xyz/v1",
  ]);
});

test("hosted /api/v1 bases keep the entered base first so it wins when it serves models", async () => {
  const { getModelListBaseCandidates } = await load();

  assert.deepEqual(getModelListBaseCandidates("https://openrouter.ai/api/v1"), [
    "https://openrouter.ai/api/v1",
    "https://openrouter.ai/v1",
  ]);
});

test("normalizes trailing slashes and endpoint suffixes before deriving candidates", async () => {
  const { getModelListBaseCandidates } = await load();

  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234/"), [
    "http://127.0.0.1:1234",
    "http://127.0.0.1:1234/v1",
  ]);
  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234/v1/models"), [
    "http://127.0.0.1:1234/v1",
  ]);
  assert.deepEqual(getModelListBaseCandidates(""), []);
});

// Regression for #1309: query strings must not break /v1 detection or native
// /api/v0|/api/v1 sibling derivation.
test("preserves query strings while deriving /v1 candidates", async () => {
  const { getModelListBaseCandidates } = await load();

  assert.deepEqual(getModelListBaseCandidates("https://gateway.example.com/v1?api-key=secret"), [
    "https://gateway.example.com/v1?api-key=secret",
  ]);
  assert.deepEqual(getModelListBaseCandidates("https://gateway.example.com?api-key=secret"), [
    "https://gateway.example.com?api-key=secret",
    "https://gateway.example.com/v1?api-key=secret",
  ]);
  assert.deepEqual(getModelListBaseCandidates("http://127.0.0.1:1234/api/v1?token=abc"), [
    "http://127.0.0.1:1234/api/v1?token=abc",
    "http://127.0.0.1:1234/v1?token=abc",
  ]);
  assert.deepEqual(
    getModelListBaseCandidates("https://api.example.com/v1/models?api-version=2024-02-01"),
    ["https://api.example.com/v1?api-version=2024-02-01"]
  );
});
