const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STORAGE_PREFIX,
  readUnverifiedLlmKeyState,
  writeUnverifiedLlmKeyState,
  clearUnverifiedLlmKeyState,
} = require("../../src/utils/llmKeyValidationState.ts");

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("saved-but-unverified status survives a component remount without storing the key", () => {
  const storage = createStorage();
  writeUnverifiedLlmKeyState(storage, "provider:openai", {
    success: true,
    provider: "openai",
    verified: false,
    code: "NETWORK_ERROR",
    retryable: true,
    warning: "provider response",
  });

  assert.deepEqual(readUnverifiedLlmKeyState(storage, "provider:openai"), {
    success: true,
    provider: "openai",
    verified: false,
    code: "NETWORK_ERROR",
    retryable: true,
  });
  const serialized = [...storage.values.values()].join("");
  assert.equal(serialized.includes("provider response"), false);
  assert.equal(serialized.includes("api key"), false);
});

test("verified, failed, and malformed results are never persisted as warnings", () => {
  const storage = createStorage();
  const stateKey = "provider:openai";

  writeUnverifiedLlmKeyState(storage, stateKey, {
    success: true,
    provider: "openai",
    verified: true,
  });
  writeUnverifiedLlmKeyState(storage, stateKey, {
    success: false,
    provider: "openai",
    verified: false,
    code: "INVALID_KEY",
  });
  writeUnverifiedLlmKeyState(storage, stateKey, {
    success: true,
    provider: "openai",
    verified: false,
    code: "NOT_A_REAL_CODE",
  });

  assert.equal(storage.values.size, 0);
  storage.setItem(`${STORAGE_PREFIX}${encodeURIComponent(stateKey)}`, "{broken");
  assert.equal(readUnverifiedLlmKeyState(storage, stateKey), null);
});

test("clearing a warning removes its persisted status", () => {
  const storage = createStorage();
  writeUnverifiedLlmKeyState(storage, "provider:corti", {
    success: true,
    provider: "corti",
    verified: false,
    code: "RATE_LIMITED",
  });

  clearUnverifiedLlmKeyState(storage, "provider:corti");
  assert.equal(readUnverifiedLlmKeyState(storage, "provider:corti"), null);
});
