const test = require("node:test");
const assert = require("node:assert/strict");

const { createCloudConfigRequestHandler } = require("../../src/helpers/cloudConfigRequest");

test("the config handler preserves policy and upgrade response metadata", async () => {
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async (_url, options) => {
      assert.equal(options.headers["x-openwhispr-policy-version"], "1");
      return new Response(
        JSON.stringify({
          error: "Update required",
          code: "UPGRADE_REQUIRED",
          data: { minAppVersion: "2.0.0" },
        }),
        { status: 426 }
      );
    },
    withPolicyHeaders: (headers) => ({ ...headers, "x-openwhispr-policy-version": "1" }),
    logger: { error() {} },
    configPath: "stt-config",
  });

  assert.deepEqual(await handler({ sender: {} }), {
    success: false,
    error: "Update required",
    code: "UPGRADE_REQUIRED",
    status: 426,
    minAppVersion: "2.0.0",
    details: { minAppVersion: "2.0.0" },
  });
});

test("the config handler keeps successful and legacy auth results compatible", async () => {
  const responses = [
    new Response(JSON.stringify({ dictation: { mode: "streaming" } }), { status: 200 }),
    new Response("{}", { status: 401 }),
  ];
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async () => responses.shift(),
    withPolicyHeaders: (headers) => headers,
    logger: { error() {} },
    configPath: "stt-config",
  });

  assert.deepEqual(await handler({ sender: {} }), {
    success: true,
    dictation: { mode: "streaming" },
  });
  assert.deepEqual(await handler({ sender: {} }), {
    success: false,
    error: "Session expired",
    code: "AUTH_EXPIRED",
    status: 401,
  });
});

test("the note-recording-config handler applies policy headers to its route", async () => {
  let requestedUrl = null;
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.headers["x-openwhispr-policy-version"], "1");
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    },
    withPolicyHeaders: (headers) => ({ ...headers, "x-openwhispr-policy-version": "1" }),
    logger: { error() {} },
    configPath: "note-recording-config",
  });

  assert.deepEqual(await handler({ sender: {} }), { success: true, providers: [] });
  assert.equal(requestedUrl, "https://api.openwhispr.test/api/note-recording-config");
});

test("the note-recording-config handler returns a structured policy failure instead of null", async () => {
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async () =>
      new Response(
        JSON.stringify({ error: "Blocked by workspace policy", code: "POLICY_RESTRICTED" }),
        { status: 403 }
      ),
    withPolicyHeaders: (headers) => headers,
    logger: { error() {} },
    configPath: "note-recording-config",
  });

  const result = await handler({ sender: {} });
  assert.equal(result.success, false);
  assert.equal(result.code, "POLICY_RESTRICTED");
  assert.equal(result.status, 403);
  assert.equal(result.error, "Blocked by workspace policy");
});
