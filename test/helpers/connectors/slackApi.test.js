const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FIXTURES,
  fakeSlackFetch,
  ok,
  slackError,
  httpStatus,
  reset,
  offline,
} = require("./slackFixtures");

const load = () => import("../../../src/helpers/connectors/slackApi.js");

async function api(script, options = {}) {
  const { createSlackApi } = await load();
  const slack = fakeSlackFetch(script);
  const sleeps = [];
  const client = createSlackApi({
    fetchImpl: slack.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { client, slack, sleeps };
}

test("a successful call returns the body and sends the token as a bearer header", async () => {
  const { client, slack } = await api({ "chat.postMessage": [ok(FIXTURES.posted)] });

  const result = await client.call(
    "chat.postMessage",
    { channel: "C0ENG", markdown_text: "hi" },
    { token: "xoxp-t" }
  );

  assert.deepEqual(result, { ok: true, data: FIXTURES.posted });
  assert.equal(slack.calls[0].authorization, "Bearer xoxp-t");
  assert.equal(slack.calls[0].contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(slack.calls[0].params, { channel: "C0ENG", markdown_text: "hi" });
});

test("documented refusals are failed; internal_error, fatal_error and new codes are unknown", async () => {
  for (const [code, outcome] of [
    ["not_in_channel", "failed"],
    ["channel_not_found", "failed"],
    ["token_expired", "failed"],
    ["is_archived", "failed"],
    ["internal_error", "unknown"],
    ["fatal_error", "unknown"],
    ["some_new_code", "unknown"],
  ]) {
    const { client } = await api({ "chat.postMessage": [slackError(code)] });
    const result = await client.call("chat.postMessage", {}, { token: "t" });
    assert.equal(result.ok, false);
    assert.equal(result.source, "slack");
    assert.equal(result.errorCode, code);
    assert.equal(result.outcome, outcome, code);
  }
});

test("a reset after sending is unknown; a DNS failure before connecting is failed", async () => {
  const afterWrite = await (
    await api({ "chat.postMessage": [reset()] })
  ).client.call("chat.postMessage");
  assert.deepEqual(
    { outcome: afterWrite.outcome, errorCode: afterWrite.errorCode, source: afterWrite.source },
    { outcome: "unknown", errorCode: "ECONNRESET", source: "network" }
  );

  const beforeConnect = await (
    await api({ "chat.postMessage": [offline()] })
  ).client.call("chat.postMessage");
  assert.equal(beforeConnect.outcome, "failed");
  assert.equal(beforeConnect.errorCode, "ENOTFOUND");
});

test("5xx and an unreadable 200 are unknown; other 4xx are failed", async () => {
  const serverError = await (
    await api({ "chat.postMessage": [httpStatus(503)] })
  ).client.call("chat.postMessage");
  assert.deepEqual([serverError.outcome, serverError.errorCode], ["unknown", "http_503"]);

  const unreadable = await (
    await api({ "chat.postMessage": [{ status: 200, rawBody: "<html>oops</html>" }] })
  ).client.call("chat.postMessage");
  assert.deepEqual([unreadable.outcome, unreadable.errorCode], ["unknown", "bad_response"]);

  const badRequest = await (
    await api({ "chat.postMessage": [httpStatus(400)] })
  ).client.call("chat.postMessage");
  assert.deepEqual([badRequest.outcome, badRequest.errorCode], ["failed", "http_400"]);
});

test("a 429 asking for 5 s or less is retried once", async () => {
  const { client, slack, sleeps } = await api({
    "chat.postMessage": [httpStatus(429, { "retry-after": "2" }), ok(FIXTURES.posted)],
  });

  const result = await client.call("chat.postMessage", {}, { token: "t" });

  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(slack.calls.length, 2);
});

test("a longer Retry-After, or a second 429, is failed with no further try", async () => {
  const long = await api({ "chat.postMessage": [httpStatus(429, { "retry-after": "30" })] });
  const longResult = await long.client.call("chat.postMessage");
  assert.deepEqual([longResult.outcome, longResult.errorCode], ["failed", "rate_limited"]);
  assert.equal(long.slack.calls.length, 1);
  assert.deepEqual(long.sleeps, []);

  const twice = await api({
    "chat.postMessage": [
      httpStatus(429, { "retry-after": "1" }),
      httpStatus(429, { "retry-after": "1" }),
    ],
  });
  const twiceResult = await twice.client.call("chat.postMessage");
  assert.equal(twiceResult.errorCode, "rate_limited");
  assert.equal(twice.slack.calls.length, 2);
});
