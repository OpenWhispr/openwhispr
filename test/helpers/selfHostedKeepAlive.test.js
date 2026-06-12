const test = require("node:test");
const assert = require("node:assert/strict");

function createKeepAlive() {
  const SelfHostedKeepAlive = require("../../src/helpers/selfHostedKeepAlive");
  return new SelfHostedKeepAlive();
}

test("isRunning returns false before start", () => {
  const ka = createKeepAlive();
  assert.equal(ka.isRunning(), false);
});

test("isRunning returns true after start with valid URL", () => {
  const ka = createKeepAlive();
  ka.start("http://localhost:8000/v1");
  assert.equal(ka.isRunning(), true);
  ka.stop();
});

test("stop clears the timer", () => {
  const ka = createKeepAlive();
  ka.start("http://localhost:8000/v1");
  ka.stop();
  assert.equal(ka.isRunning(), false);
});

test("start with empty URL does not activate", () => {
  const ka = createKeepAlive();
  ka.start("");
  assert.equal(ka.isRunning(), false);
});

test("start with whitespace-only URL does not activate", () => {
  const ka = createKeepAlive();
  ka.start("   ");
  assert.equal(ka.isRunning(), false);
});

test("start with same URL does not restart timer", () => {
  const ka = createKeepAlive();
  ka.start("http://localhost:8000/v1");
  const firstTimer = ka._timer;
  ka.start("http://localhost:8000/v1");
  assert.equal(ka._timer, firstTimer);
  ka.stop();
});

test("start with different URL restarts timer", () => {
  const ka = createKeepAlive();
  ka.start("http://localhost:8000/v1");
  const firstTimer = ka._timer;
  ka.start("http://localhost:9000/v1");
  assert.notEqual(ka._timer, firstTimer);
  ka.stop();
});

test("stop is safe to call multiple times", () => {
  const ka = createKeepAlive();
  ka.stop();
  ka.stop();
  assert.equal(ka.isRunning(), false);
});

test("start with null URL does not activate", () => {
  const ka = createKeepAlive();
  ka.start(null);
  assert.equal(ka.isRunning(), false);
});

test("start with undefined URL does not activate", () => {
  const ka = createKeepAlive();
  ka.start(undefined);
  assert.equal(ka.isRunning(), false);
});

test("start normalizes trailing slashes before comparing URLs", () => {
  const ka = createKeepAlive();
  ka.start("http://localhost:8000/v1/");
  const firstTimer = ka._timer;
  ka.start("http://localhost:8000/v1");
  assert.equal(ka._timer, firstTimer);
  ka.stop();
});

test("start trims whitespace from URL", () => {
  const ka = createKeepAlive();
  ka.start("  http://localhost:8000/v1  ");
  assert.equal(ka.isRunning(), true);
  assert.equal(ka._url, "http://localhost:8000/v1");
  ka.stop();
});

test("first ping fetches /models to resolve model name", () => {
  const ka = createKeepAlive();
  ka._url = "http://localhost:8000/v1";
  assert.equal(ka._model, null);
  const http = require("http");
  const originalGet = http.get;
  let requestedUrl = null;
  http.get = (url) => {
    requestedUrl = url.href || url.toString();
    return { on: () => {} };
  };
  ka._ping();
  http.get = originalGet;
  assert.equal(requestedUrl, "http://localhost:8000/v1/models");
});

test("subsequent ping sends transcription when model is cached", () => {
  const ka = createKeepAlive();
  ka._url = "http://localhost:8000/v1";
  ka._model = "test-model";
  const http = require("http");
  const originalRequest = http.request;
  let requestedUrl = null;
  http.request = (url) => {
    requestedUrl = url.href || url.toString();
    return { on: () => {}, end: () => {} };
  };
  ka._ping();
  http.request = originalRequest;
  assert.equal(requestedUrl, "http://localhost:8000/v1/audio/transcriptions");
});

test("stop after start clears internal URL and model references", () => {
  const ka = createKeepAlive();
  ka.start("http://localhost:8000/v1");
  ka._model = "cached-model";
  ka.stop();
  assert.equal(ka._url, null);
  assert.equal(ka._model, null);
});
