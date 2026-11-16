const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/deliveryClassifier.js");

test("errors raised before the request can reach the provider are failed", async () => {
  const { classifyTransportError } = await load();
  assert.equal(
    classifyTransportError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })),
    "failed"
  );
  assert.equal(
    classifyTransportError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })),
    "failed"
  );
  assert.equal(classifyTransportError(new Error("net::ERR_INTERNET_DISCONNECTED")), "failed");
  assert.equal(classifyTransportError(new Error("net::ERR_NAME_NOT_RESOLVED")), "failed");
});

test("anything that may have reached the provider is unknown", async () => {
  const { classifyTransportError } = await load();
  assert.equal(
    classifyTransportError(Object.assign(new Error("reset"), { code: "ECONNRESET" })),
    "unknown"
  );
  assert.equal(classifyTransportError(new Error("net::ERR_CONNECTION_RESET")), "unknown");
  assert.equal(
    classifyTransportError(Object.assign(new Error("aborted"), { name: "AbortError" })),
    "unknown"
  );
  assert.equal(classifyTransportError(new Error("socket hang up")), "unknown");
  assert.equal(classifyTransportError(undefined), "unknown");
});

test("HTTP statuses: only 4xx proves the provider rejected the request", async () => {
  const { classifyHttpStatus } = await load();
  assert.equal(classifyHttpStatus(200), "ok");
  assert.equal(classifyHttpStatus(201), "ok");
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    assert.equal(classifyHttpStatus(status), "failed", String(status));
  }
  // A 5xx says nothing about whether the provider acted before failing.
  for (const status of [500, 501, 502, 503, 504, 302, 100]) {
    assert.equal(classifyHttpStatus(status), "unknown", String(status));
  }
});

test("provider error codes are failed only when documented as rejected before acting", async () => {
  const { classifyProviderError } = await load();
  const slackRejections = new Set(["channel_not_found", "not_in_channel", "invalid_auth"]);
  assert.equal(classifyProviderError("not_in_channel", slackRejections), "failed");
  // Slack: "It's possible some aspect of the operation succeeded before the error was raised."
  assert.equal(classifyProviderError("internal_error", slackRejections), "unknown");
  assert.equal(classifyProviderError("fatal_error", slackRejections), "unknown");
  assert.equal(classifyProviderError("brand_new_code", slackRejections), "unknown");
  assert.equal(classifyProviderError(undefined, slackRejections), "unknown");
});

test("a failed request reports its code, never its message", async () => {
  const { transportErrorCode } = await load();
  assert.equal(
    transportErrorCode(Object.assign(new Error("x"), { code: "ENOTFOUND" })),
    "ENOTFOUND"
  );
  assert.equal(
    transportErrorCode(new Error("net::ERR_INTERNET_DISCONNECTED (https://slack.com/api/x)")),
    "ERR_INTERNET_DISCONNECTED",
    "Electron's net.fetch names the error only in the message"
  );
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(transportErrorCode(timeout), "timeout");
  assert.equal(transportErrorCode(new Error("something odd")), "network_error");
  assert.equal(
    transportErrorCode(new Error("net::ERR_HTTP2_PROTOCOL_ERROR")),
    "ERR_HTTP2_PROTOCOL_ERROR",
    "codes with digits are kept whole"
  );
});

test("only the codes transportErrorCode produces count as transport codes", async () => {
  const { isTransportErrorCode } = await load();
  for (const code of [
    "ENOTFOUND",
    "ERR_CONNECTION_RESET",
    "UND_ERR_SOCKET",
    "timeout",
    "network_error",
  ]) {
    assert.equal(isTransportErrorCode(code), true, code);
  }
  for (const code of ["invalid_grant", "rate_limited", "", null, undefined]) {
    assert.equal(isTransportErrorCode(code), false, String(code));
  }
});

test("Retry-After counts only as seconds", async () => {
  const { retryAfterMs } = await load();
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assert.equal(retryAfterMs(""), null);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("-1"), null);
});
