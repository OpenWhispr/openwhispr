const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function createTestHarness() {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-token-test-"));
  const fakeElectron = {
    app: { getPath: () => tmpUserData },
    safeStorage: { isEncryptionAvailable: () => false },
  };

  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return fakeElectron;
    if (request === "@napi-rs/keyring") throw new Error("keyring disabled in tests");
    return origLoad.call(this, request, ...rest);
  };

  const tokenStorePath = require.resolve("../../src/helpers/tokenStore");
  delete require.cache[tokenStorePath];
  const tokenStore = require(tokenStorePath);

  const cleanup = () => {
    Module._load = origLoad;
    delete require.cache[tokenStorePath];
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    } catch {}
  };

  return { tokenStore, tmpUserData, cleanup };
}

test("unauthenticated read returns null on initial and subsequent get calls", () => {
  const { tokenStore, cleanup } = createTestHarness();
  try {
    const first = tokenStore.get();
    assert.equal(first, null, "initial get() on missing token file must return null");

    const second = tokenStore.get();
    assert.equal(second, null, "subsequent get() must return null");
  } finally {
    cleanup();
  }
});

test("unauthenticated read returns null token in getState on initial and subsequent calls", () => {
  const { tokenStore, cleanup } = createTestHarness();
  try {
    const firstState = tokenStore.getState();
    assert.deepEqual(
      firstState,
      { token: null, generation: 0 },
      "initial getState() must return token: null"
    );

    const secondState = tokenStore.getState();
    assert.deepEqual(
      secondState,
      { token: null, generation: 0 },
      "subsequent getState() must return token: null"
    );
  } finally {
    cleanup();
  }
});

test("set stores token and publishes state update", () => {
  const { tokenStore, cleanup } = createTestHarness();
  try {
    const result = tokenStore.set("test-bearer-token");
    assert.deepEqual(result, {
      success: true,
      token: "test-bearer-token",
      generation: 1,
    });
    assert.equal(tokenStore.get(), "test-bearer-token");
    assert.deepEqual(tokenStore.getState(), {
      token: "test-bearer-token",
      generation: 1,
    });
  } finally {
    cleanup();
  }
});

test("set rejects empty or non-string token without changing state", () => {
  const { tokenStore, cleanup } = createTestHarness();
  try {
    const emptyResult = tokenStore.set("");
    assert.equal(emptyResult.success, false);
    assert.equal(emptyResult.token, null);
    assert.equal(emptyResult.generation, 0);

    const nonStringResult = tokenStore.set(12345);
    assert.equal(nonStringResult.success, false);
    assert.equal(nonStringResult.token, null);
    assert.equal(tokenStore.get(), null);
  } finally {
    cleanup();
  }
});

test("setIfGeneration validates generation guard", () => {
  const { tokenStore, cleanup } = createTestHarness();
  try {
    const mismatch = tokenStore.setIfGeneration("token-1", 999);
    assert.equal(mismatch.success, false);
    assert.equal(mismatch.code, "AUTH_CONTEXT_CHANGED");
    assert.equal(mismatch.generation, 0);
    assert.equal(tokenStore.get(), null);

    const match = tokenStore.setIfGeneration("token-1", 0);
    assert.equal(match.success, true);
    assert.equal(match.token, "token-1");
    assert.equal(match.generation, 1);
    assert.equal(tokenStore.get(), "token-1");
  } finally {
    cleanup();
  }
});

test("clear unlinks token and resets state with incremented generation", () => {
  const { tokenStore, tmpUserData, cleanup } = createTestHarness();
  try {
    tokenStore.set("token-to-clear");
    const tokenFilePath = path.join(tmpUserData, "auth-token.bin");
    assert.equal(fs.existsSync(tokenFilePath), true);

    const clearResult = tokenStore.clear();
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.token, null);
    assert.equal(clearResult.generation, 2);
    assert.equal(tokenStore.get(), null);
    assert.equal(fs.existsSync(tokenFilePath), false);
  } finally {
    cleanup();
  }
});

test("subscribe notifies listeners on set and clear and allows unsubscribe", () => {
  const { tokenStore, cleanup } = createTestHarness();
  try {
    const events = [];
    const unsubscribe = tokenStore.subscribe((state) => {
      events.push(state);
    });

    tokenStore.set("token-alpha");
    tokenStore.clear();
    unsubscribe();
    tokenStore.set("token-beta");

    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { token: "token-alpha", generation: 1 });
    assert.deepEqual(events[1], { token: null, generation: 2 });
  } finally {
    cleanup();
  }
});
