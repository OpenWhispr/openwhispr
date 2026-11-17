const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  parseSelfHostedSttHeaders,
  selfHostedSttHeaderProblem,
  selfHostedSttRequest,
  serializeSelfHostedSttHeaders,
} = require("../../src/helpers/selfHostedSttHeaders.js");
const {
  testProviderConnection,
  resolveProviderRequest,
} = require("../../src/helpers/providerConnectionTest");
const { createConnectionCheckCache } = require("../../src/helpers/connectionCheckCache");

const rows = [{ name: "X-API-Key", value: "local-test-key" }];

test("each server's headers survive storage; empty rows and garbage don't", () => {
  const headers = { dictation: rows, upload: [{ name: "X-Upload", value: "u" }] };
  assert.deepEqual(parseSelfHostedSttHeaders(serializeSelfHostedSttHeaders(headers)), headers);
  assert.deepEqual(
    parseSelfHostedSttHeaders(
      serializeSelfHostedSttHeaders({ dictation: [...rows, { name: " ", value: "" }], upload: [] })
    ),
    { dictation: rows, upload: [] }
  );
  for (const stored of ["", null, "invalid", "[]", '{"dictation":[{"name":4,"value":"x"}]}']) {
    assert.deepEqual(parseSelfHostedSttHeaders(stored), { dictation: [], upload: [] });
  }
});

test("a list with no header left stores as nothing, so the secret is deleted", () => {
  assert.equal(serializeSelfHostedSttHeaders({ dictation: [], upload: [] }), "");
  assert.equal(
    serializeSelfHostedSttHeaders({ dictation: [{ name: "", value: "" }], upload: [] }),
    ""
  );
});

test("each row's problem is named so the panel can show it on that row", () => {
  const cases = [
    [{ name: "", value: "" }, null],
    [{ name: "X-API-Key ", value: "secret" }, null],
    [{ name: "X-Empty", value: "" }, null],
    [{ name: "", value: "secret" }, "missingName"],
    [{ name: "X-API-Key: secret", value: "" }, "invalidName"],
    [{ name: "bad name", value: "secret" }, "invalidName"],
    [{ name: "Content-Type", value: "text/plain" }, "reserved"],
    [{ name: "proxy-authorization", value: "x" }, "reserved"],
    [{ name: "X-Key", value: "secret\r\nInjected: value" }, "invalidValue"],
    [{ name: "X-Key", value: "“curly”" }, "invalidValue"],
    [{ name: "X-Key", value: "秘密" }, "invalidValue"],
  ];
  for (const [row, problem] of cases) {
    assert.equal(selfHostedSttHeaderProblem(row), problem, JSON.stringify(row));
  }
});

test("a request trims names, lets its own auth win and refuses redirects only with a header", () => {
  assert.deepEqual(
    selfHostedSttRequest(
      [
        { name: " X-API-Key ", value: "local-test-key" },
        { name: "authorization", value: "override" },
      ],
      { Authorization: "Bearer original" }
    ),
    {
      headers: { "x-api-key": "local-test-key", authorization: "Bearer original" },
      redirect: "error",
    }
  );
  for (const empty of [undefined, [], [{ name: "", value: "" }]]) {
    assert.deepEqual(selfHostedSttRequest(empty, { Authorization: "Bearer k" }), {
      headers: { authorization: "Bearer k" },
      redirect: "follow",
    });
  }
});

test("an invalid header throws a translated, Settings-linked error that holds no secret", () => {
  for (const row of [
    { name: "Content-Type", value: "secret" },
    { name: "bad name", value: "secret" },
    { name: "", value: "secret" },
  ]) {
    assert.throws(
      () => selfHostedSttRequest([row]),
      (error) => {
        assert.equal(error.code, "PROVIDER_INVALID_HEADERS");
        assert.equal(error.messageKey, "providerErrors.selfHosted.invalidHeaders");
        assert.equal(error.settingsTarget, "speechToText");
        assert.equal(error.errorCode, "invalidHeaders");
        assert.doesNotMatch(error.message, /secret/);
        return true;
      }
    );
  }
});

test("connection checks only attach supplied headers to custom STT", () => {
  for (const config of [
    { provider: "openai", scope: "transcription", apiKey: "key" },
    { provider: "custom", scope: "reasoning", baseUrl: "http://localhost:8178" },
  ]) {
    assert.equal(
      resolveProviderRequest({ ...config, headers: rows }).headers["x-api-key"],
      undefined
    );
  }
});

test("a changed header invalidates a successful connection check", async () => {
  const cached = createConnectionCheckCache();
  let calls = 0;
  const run = () => {
    calls++;
    return { success: true };
  };
  await cached({ headers: rows }, run);
  await cached({ headers: rows }, run);
  await cached({ headers: [] }, run);
  assert.equal(calls, 2);
});

test("a server that requires X-API-Key passes the check only with the header", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    if (req.headers["x-api-key"] !== "local-test-key") {
      res.writeHead(401);
      res.end('{"error":"key required"}');
      return;
    }
    res.end(JSON.stringify({ data: [{ id: "whisper-1" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = { provider: "custom", scope: "transcription", baseUrl, model: "whisper-1" };
  const refused = await testProviderConnection(config);
  assert.equal(refused.errorCode, "credentialsRejected");
  assert.equal((await testProviderConnection({ ...config, headers: rows })).success, true);
});

test("a check with custom headers refuses a redirect and names it", async (t) => {
  let destinationCalls = 0;
  const destination = http.createServer((_req, res) => {
    destinationCalls++;
    res.end("{}");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/v1/models` });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const server of [redirect, destination]) {
      server.closeAllConnections();
      server.close();
    }
  });
  const result = await testProviderConnection({
    provider: "custom",
    scope: "transcription",
    baseUrl: `http://127.0.0.1:${redirect.address().port}/v1`,
    model: "whisper-1",
    headers: rows,
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "redirected");
  assert.equal(result.unverified, undefined);
  assert.equal(destinationCalls, 0);
});

test("empty header drafts keep redirect follow and invalid headers never reach HTTP", async () => {
  const config = {
    provider: "custom",
    scope: "transcription",
    baseUrl: "http://127.0.0.1:8178/v1",
    model: "whisper-1",
  };
  for (const headers of [undefined, [], [{ name: "", value: "" }]]) {
    assert.equal(resolveProviderRequest({ ...config, headers }).redirect, "follow");
  }
  assert.equal(resolveProviderRequest({ ...config, headers: rows }).redirect, "error");
  const failure = await testProviderConnection(
    { ...config, headers: [{ name: "bad name", value: "secret" }] },
    () => {
      assert.fail("invalid headers must not reach HTTP");
    }
  );
  assert.equal(failure.errorCode, "invalidHeaders");
  assert.doesNotMatch(failure.error, /secret/);
});
