const test = require("node:test");
const assert = require("node:assert/strict");

const {
  realtimeUrlFromBase,
  DEFAULT_REALTIME_URL,
  CUSTOM_REALTIME_BASE_URL_ERROR,
} = require("../../src/helpers/realtimeUrl.js");

test("uses the exact OpenAI URL when no custom base is configured", () => {
  assert.equal(realtimeUrlFromBase(undefined, "whisper"), DEFAULT_REALTIME_URL);
  assert.equal(realtimeUrlFromBase("", "whisper"), DEFAULT_REALTIME_URL);
  assert.ok(!DEFAULT_REALTIME_URL.includes("model="));
});

test("derives a wss URL from an https base and carries the custom model", () => {
  const url = new URL(realtimeUrlFromBase("https://ai.example.com/v1", "whisper"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "ai.example.com");
  assert.equal(url.pathname, "/v1/realtime");
  assert.equal(url.searchParams.get("intent"), "transcription");
  assert.equal(url.searchParams.get("model"), "whisper");
});

test("allows plaintext http only for private/self-hosted hosts", () => {
  for (const base of [
    "http://localhost:8000/v1",
    "http://127.0.0.1:8000/v1",
    "http://192.168.1.20:8000/v1",
    "http://100.64.0.10:8000/v1",
    "http://speechbox.tailnet.ts.net/v1",
  ]) {
    assert.equal(new URL(realtimeUrlFromBase(base, "whisper")).protocol, "ws:");
  }
  assert.throws(
    () => realtimeUrlFromBase("http://public.example.com/v1", "whisper"),
    new Error(CUSTOM_REALTIME_BASE_URL_ERROR)
  );
});

test("tolerates trailing slashes, path prefixes, and an existing /realtime suffix", () => {
  assert.equal(
    new URL(realtimeUrlFromBase("https://ai.example.com/v1///", "whisper")).pathname,
    "/v1/realtime"
  );
  assert.equal(
    new URL(realtimeUrlFromBase("https://gw.example.com/stt/v1", "whisper")).pathname,
    "/stt/v1/realtime"
  );
  assert.equal(
    new URL(realtimeUrlFromBase("https://ai.example.com/v1/realtime", "whisper")).pathname,
    "/v1/realtime"
  );
});

test("omits the model param when no model is given", () => {
  const url = new URL(realtimeUrlFromBase("https://ai.example.com/v1", ""));
  assert.equal(url.searchParams.get("model"), null);
  assert.equal(url.searchParams.get("intent"), "transcription");
});

test("configured malformed and non-http custom bases fail closed", () => {
  for (const base of ["not a url", "file:///etc/passwd", "ftp://example.com/v1"]) {
    assert.throws(
      () => realtimeUrlFromBase(base, "whisper"),
      new Error(CUSTOM_REALTIME_BASE_URL_ERROR)
    );
  }
});
