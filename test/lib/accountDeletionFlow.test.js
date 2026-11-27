const test = require("node:test");
const assert = require("node:assert/strict");

const { executeAccountDeletion } = require("../../src/lib/accountDeletionFlow.ts");

function operations(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      deleteRemoteAccount: async () => calls.push("remote"),
      deleteLocalAccountData: async () => calls.push("local-account"),
      clearWorkspaceSessionState: async () => calls.push("workspace-session"),
      signOut: async () => calls.push("sign-out"),
      eraseDeviceData: async () => calls.push("erase-device"),
      ...overrides,
    },
  };
}

test("a rejected server deletion leaves every local and auth boundary untouched", async () => {
  const { calls, dependencies } = operations({
    deleteRemoteAccount: async () => {
      calls.push("remote");
      throw new Error("server rejected deletion");
    },
  });

  await assert.rejects(
    executeAccountDeletion({ eraseDeviceData: true, dependencies }),
    /server rejected deletion/
  );
  assert.deepEqual(calls, ["remote"]);
});

test("default account deletion preserves device-wide data", async () => {
  const { calls, dependencies } = operations();

  const result = await executeAccountDeletion({ eraseDeviceData: false, dependencies });

  assert.deepEqual(calls, ["remote", "local-account", "workspace-session", "sign-out"]);
  assert.deepEqual(result.localCleanupFailures, []);
});

test("explicit device erasure runs only after account cleanup and sign-out", async () => {
  const { calls, dependencies } = operations();

  const result = await executeAccountDeletion({ eraseDeviceData: true, dependencies });

  assert.deepEqual(calls, [
    "remote",
    "local-account",
    "workspace-session",
    "sign-out",
    "erase-device",
  ]);
  assert.deepEqual(result.localCleanupFailures, []);
});

test("a local account cleanup failure cannot strand the deleted remote session", async () => {
  const { calls, dependencies } = operations({
    deleteLocalAccountData: async () => {
      calls.push("local-account");
      throw new Error("database busy");
    },
  });

  const result = await executeAccountDeletion({ eraseDeviceData: false, dependencies });

  assert.deepEqual(calls, ["remote", "local-account", "workspace-session", "sign-out"]);
  assert.deepEqual(result.localCleanupFailures, ["local-account-data"]);
});

test("a deleted account is never presented offline, even if sign-out never runs", async (t) => {
  const values = new Map([["openwhispr:accountProfile", "{}"]]);
  const previousWindow = global.window;
  global.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  t.after(() => {
    global.window = previousWindow;
  });
  const profileKeptAfterServerDelete = [];
  const { dependencies } = operations({
    // The first local step after the server deleted the account.
    deleteLocalAccountData: async () => {
      profileKeptAfterServerDelete.push(values.has("openwhispr:accountProfile"));
    },
  });

  await executeAccountDeletion({ eraseDeviceData: false, dependencies });

  assert.deepEqual(profileKeptAfterServerDelete, [false]);
});
