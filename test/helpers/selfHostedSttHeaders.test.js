const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  mergeSelfHostedSttHeaders,
  parseSelfHostedSttHeaders,
} = require("../../src/helpers/selfHostedSttHeaders.js");
const {
  testProviderConnection,
  resolveProviderRequest,
} = require("../../src/helpers/providerConnectionTest");
const { createConnectionCheckCache } = require("../../src/helpers/connectionCheckCache");

const rows = [{ name: "X-API-Key", value: "local-test-key" }];

test("header rows survive serialization, empty drafts, edits and deletion", () => {
  assert.deepEqual(parseSelfHostedSttHeaders(JSON.stringify(rows)), rows);
  assert.deepEqual(parseSelfHostedSttHeaders("invalid"), []);
  assert.deepEqual(parseSelfHostedSttHeaders('[{"name":4,"value":"secret"}]'), []);
  assert.deepEqual(mergeSelfHostedSttHeaders([{ name: "", value: "" }]), {});
  assert.deepEqual(mergeSelfHostedSttHeaders([...rows, { name: "x-api-key", value: "edited" }]), {
    "x-api-key": "edited",
  });
});

test("existing auth wins case-insensitively and request-owned headers cannot be overridden", () => {
  assert.equal(
    mergeSelfHostedSttHeaders([{ name: "authorization", value: "override" }], {
      Authorization: "Bearer original",
    }).authorization,
    "Bearer original"
  );
  for (const name of [
    "Content-Type",
    "Content-Length",
    "Host",
    "Transfer-Encoding",
    "Connection",
  ]) {
    assert.throws(() => mergeSelfHostedSttHeaders([{ name, value: "secret" }]), {
      message: "Invalid self-hosted STT HTTP header.",
    });
  }
  for (const [name, value] of [
    ["bad name", "secret"],
    ["X-Key", "secret\r\nInjected: value"],
    ["X-Key", "秘密"],
    ["", "secret"],
  ]) {
    assert.throws(() => mergeSelfHostedSttHeaders([{ name, value }]), {
      message: "Invalid self-hosted STT HTTP header.",
    });
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

test("local HTTP server requires X-API-Key for model checks and multipart transcription", async (t) => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    if (req.headers["x-api-key"] !== "local-test-key") {
      res.writeHead(401);
      res.end('{"error":"key required"}');
      return;
    }
    res.end(
      JSON.stringify(
        req.url === "/v1/models" ? { data: [{ id: "whisper-1" }] } : { text: "테스트 결과" }
      )
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = { provider: "custom", scope: "transcription", baseUrl, model: "whisper-1" };
  assert.equal((await testProviderConnection(config)).success, false);
  assert.equal((await testProviderConnection({ ...config, headers: rows })).success, true);
  const body = new FormData();
  body.append("model", "whisper-1");
  body.append("file", new Blob(["audio"]), "audio.wav");
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: mergeSelfHostedSttHeaders(rows),
    body,
  });
  assert.deepEqual(await response.json(), { text: "테스트 결과" });
  assert.match(received.at(-1).headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.ok(
    received.at(-1).body.includes(received.at(-1).headers["content-type"].split("boundary=")[1])
  );
});

test("custom STT connection checks refuse redirects when configured with secret headers", async (t) => {
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
  assert.equal(destinationCalls, 0);
});

test("empty header drafts preserve redirect follow and invalid headers identify the header error", async () => {
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
