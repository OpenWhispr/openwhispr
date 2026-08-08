const test = require("node:test");
const assert = require("node:assert/strict");

const { realtimeUrlFromBase, DEFAULT_REALTIME_URL } = require("../../src/helpers/realtimeUrl.js");

test("falls back to OpenAI when no base is configured", () => {
  assert.equal(realtimeUrlFromBase(undefined, "whisper"), DEFAULT_REALTIME_URL);
  assert.equal(realtimeUrlFromBase("", "whisper"), DEFAULT_REALTIME_URL);
  assert.equal(realtimeUrlFromBase("   ", "whisper"), DEFAULT_REALTIME_URL);
});

test("leaves the OpenAI URL untouched, model included", () => {
  // The model must not leak into OpenAI's URL: it selects via session.update.
  assert.ok(!DEFAULT_REALTIME_URL.includes("model="));
  assert.equal(realtimeUrlFromBase(null, "gpt-4o-mini-transcribe"), DEFAULT_REALTIME_URL);
});

test("derives a wss URL from an https base", () => {
  const url = new URL(realtimeUrlFromBase("https://ai.example.com/v1", "whisper"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "ai.example.com");
  assert.equal(url.pathname, "/v1/realtime");
  assert.equal(url.searchParams.get("intent"), "transcription");
  assert.equal(url.searchParams.get("model"), "whisper");
});

test("derives a ws URL from a plaintext http base", () => {
  const url = new URL(realtimeUrlFromBase("http://localhost:8000/v1", "whisper"));
  assert.equal(url.protocol, "ws:");
  assert.equal(url.host, "localhost:8000");
  assert.equal(url.pathname, "/v1/realtime");
});

test("tolerates trailing slashes", () => {
  const url = new URL(realtimeUrlFromBase("https://ai.example.com/v1///", "whisper"));
  assert.equal(url.pathname, "/v1/realtime");
});

test("does not double up when the base already points at /realtime", () => {
  const url = new URL(realtimeUrlFromBase("https://ai.example.com/v1/realtime", "whisper"));
  assert.equal(url.pathname, "/v1/realtime");
});

test("preserves a base mounted under a path prefix", () => {
  const url = new URL(realtimeUrlFromBase("https://gw.example.com/stt/v1", "whisper"));
  assert.equal(url.pathname, "/stt/v1/realtime");
});

test("omits the model param when no model is given", () => {
  const url = new URL(realtimeUrlFromBase("https://ai.example.com/v1", ""));
  assert.equal(url.searchParams.get("model"), null);
  assert.equal(url.searchParams.get("intent"), "transcription");
});

test("falls back to OpenAI for unusable or non-http bases", () => {
  assert.equal(realtimeUrlFromBase("not a url", "whisper"), DEFAULT_REALTIME_URL);
  assert.equal(realtimeUrlFromBase("file:///etc/passwd", "whisper"), DEFAULT_REALTIME_URL);
  assert.equal(realtimeUrlFromBase("ftp://example.com/v1", "whisper"), DEFAULT_REALTIME_URL);
});
