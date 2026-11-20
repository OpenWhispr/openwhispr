// The Titanium license key is a credential for our own services only (D-08).
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/titanium/titaniumHosts.js");

const FORK = {
  DEFAULT_STT: { baseUrl: "https://stt.titaniumlabs.test/v1" },
  TITANIUM: { serviceHosts: ["search.titaniumlabs.test"] },
};

test("recognizes the default STT host and listed service hosts, any path or case", async () => {
  const { isTitaniumServiceUrl } = await load();

  assert.equal(
    isTitaniumServiceUrl("https://stt.titaniumlabs.test/v1/chat/completions", FORK),
    true
  );
  assert.equal(
    isTitaniumServiceUrl("wss://STT.titaniumlabs.test/v1/transcriptions/stream", FORK),
    true
  );
  assert.equal(isTitaniumServiceUrl("https://search.titaniumlabs.test/x", FORK), true);
});

test("refuses foreign, lookalike and malformed URLs", async () => {
  const { isTitaniumServiceUrl } = await load();

  assert.equal(isTitaniumServiceUrl("https://api.openai.com/v1", FORK), false);
  assert.equal(isTitaniumServiceUrl("https://stt.titaniumlabs.test.evil.example/v1", FORK), false);
  assert.equal(isTitaniumServiceUrl("https://evil.example/?h=stt.titaniumlabs.test", FORK), false);
  assert.equal(isTitaniumServiceUrl("not a url", FORK), false);
  assert.equal(isTitaniumServiceUrl("", FORK), false);
  assert.equal(isTitaniumServiceUrl(undefined, FORK), false);
});

test("an empty or missing fork config matches nothing", async () => {
  const { isTitaniumServiceUrl } = await load();

  assert.equal(isTitaniumServiceUrl("https://stt.titaniumlabs.test/v1", {}), false);
  assert.equal(isTitaniumServiceUrl("https://stt.titaniumlabs.test/v1"), false);
  assert.equal(
    isTitaniumServiceUrl("https://stt.titaniumlabs.test/v1", { DEFAULT_STT: { baseUrl: "" } }),
    false
  );
});
