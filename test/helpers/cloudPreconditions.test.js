const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkCloudPreconditions,
  NOT_CONFIGURED,
  NOT_AUTHENTICATED,
} = require("../../src/helpers/cloudPreconditions");
const { createCloudConfigRequestHandler } = require("../../src/helpers/cloudConfigRequest");

test("missing API URL is an expected state, not an error", () => {
  const gate = checkCloudPreconditions("", { Authorization: "Bearer t" });
  assert.equal(gate.ok, false);
  assert.equal(gate.result.success, false);
  assert.equal(gate.result.code, NOT_CONFIGURED);
  assert.equal(typeof gate.result.error, "string");
});

test("empty auth header is an expected state, not an error", () => {
  const gate = checkCloudPreconditions("https://api.example.com", {});
  assert.equal(gate.ok, false);
  assert.equal(gate.result.code, NOT_AUTHENTICATED);
});

test("a missing auth header is treated as unauthenticated", () => {
  for (const header of [undefined, null]) {
    const gate = checkCloudPreconditions("https://api.example.com", header);
    assert.equal(gate.ok, false);
    assert.equal(gate.result.code, NOT_AUTHENTICATED);
  }
});

test("an unconfigured URL is reported before authentication", () => {
  const gate = checkCloudPreconditions("", {});
  assert.equal(gate.result.code, NOT_CONFIGURED);
});

test("both preconditions met lets the caller proceed", () => {
  const gate = checkCloudPreconditions("https://api.example.com", { Cookie: "session=abc" });
  assert.equal(gate.ok, true);
  assert.equal(gate.result, undefined);
});

// Regression: the whole point of the change is that an unconfigured or
// unauthenticated install does NOT log at error level on startup. Prove the
// factory-built handler stays off logger.error and never issues a fetch.
function makeLogger() {
  const calls = { debug: [], error: [] };
  return {
    logger: {
      debug: (...args) => calls.debug.push(args),
      error: (...args) => calls.error.push(args),
    },
    calls,
  };
}

test("handler returns NOT_CONFIGURED at debug level without fetching or error-logging", async () => {
  const { logger, calls } = makeLogger();
  let fetched = false;
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "",
    getAuthHeader: async () => ({ Authorization: "Bearer t" }),
    proxyFetch: async () => {
      fetched = true;
      throw new Error("should not fetch");
    },
    withPolicyHeaders: (h) => h,
    logger,
    configPath: "stt-config",
  });

  const result = await handler({});
  assert.equal(result.success, false);
  assert.equal(result.code, NOT_CONFIGURED);
  assert.equal(fetched, false, "must not hit the network when unconfigured");
  assert.equal(calls.error.length, 0, "must not log at error level for an expected state");
  assert.equal(calls.debug.length, 1);
});

test("handler returns NOT_AUTHENTICATED at debug level when the session is not ready", async () => {
  const { logger, calls } = makeLogger();
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.example.com",
    getAuthHeader: async () => ({}),
    proxyFetch: async () => {
      throw new Error("should not fetch");
    },
    withPolicyHeaders: (h) => h,
    logger,
    configPath: "note-recording-config",
  });

  const result = await handler({});
  assert.equal(result.code, NOT_AUTHENTICATED);
  assert.equal(calls.error.length, 0);
});

test("a genuine fetch failure still logs at error level", async () => {
  const { logger, calls } = makeLogger();
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.example.com",
    getAuthHeader: async () => ({ Authorization: "Bearer t" }),
    proxyFetch: async () => {
      throw new Error("network down");
    },
    withPolicyHeaders: (h) => h,
    logger,
    configPath: "stt-config",
  });

  const result = await handler({});
  assert.equal(result.success, false);
  assert.equal(calls.error.length, 1, "real failures must still surface at error level");
});
