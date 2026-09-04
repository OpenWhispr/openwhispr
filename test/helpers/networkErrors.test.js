const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { classifyNetworkError } = require("../../src/helpers/networkErrors");

describe("classifyNetworkError", () => {
  it("treats ENOTFOUND as a DNS failure", () => {
    const classified = classifyNetworkError({ code: "ENOTFOUND" });
    assert.equal(classified.isNetworkError, true);
    assert.equal(classified.messageKey, "streaming.errors.cloudUnreachable.dnsBlocked");
  });

  it("treats transient DNS (EAI_AGAIN) the same as ENOTFOUND", () => {
    const classified = classifyNetworkError({ code: "EAI_AGAIN" });
    assert.equal(classified.isNetworkError, true);
    assert.equal(classified.messageKey, "streaming.errors.cloudUnreachable.dnsBlocked");
  });

  it("reads EAI_AGAIN from error.cause when the top-level code is missing", () => {
    const classified = classifyNetworkError({ cause: { code: "EAI_AGAIN" } });
    assert.equal(classified.isNetworkError, true);
    assert.equal(classified.messageKey, "streaming.errors.cloudUnreachable.dnsBlocked");
  });

  it("treats a broken pipe as a refused connection", () => {
    const classified = classifyNetworkError({ code: "EPIPE" });
    assert.equal(classified.isNetworkError, true);
    assert.equal(classified.messageKey, "streaming.errors.cloudUnreachable.refused");
  });

  it("leaves unknown codes unclassified", () => {
    assert.deepEqual(classifyNetworkError({ code: "EPERM" }), { isNetworkError: false });
    assert.deepEqual(classifyNetworkError(null), { isNetworkError: false });
  });
});
