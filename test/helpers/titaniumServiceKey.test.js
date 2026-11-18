// The Titanium license key is a credential for our own services only (STT-02).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  titaniumServiceKeyFor,
  _setSessionForTest,
} = require("../../src/helpers/titanium/titaniumIpc");

const FORK = {
  DEFAULT_STT: { baseUrl: "https://stt.titaniumlabs.test/v1" },
  TITANIUM: { serviceHosts: ["search.titaniumlabs.test"] },
};
const signedIn = { getLicenseKey: () => "key/abc.sig" };

test("hands the license key to our STT host and listed service hosts only", () => {
  _setSessionForTest(signedIn);
  try {
    assert.equal(
      titaniumServiceKeyFor("https://stt.titaniumlabs.test/v1/audio/transcriptions", FORK),
      "key/abc.sig"
    );
    assert.equal(titaniumServiceKeyFor("https://SEARCH.titaniumlabs.test/x", FORK), "key/abc.sig");
    assert.equal(titaniumServiceKeyFor("https://api.openai.com/v1", FORK), null);
    assert.equal(
      titaniumServiceKeyFor("https://stt.titaniumlabs.test.evil.example/v1", FORK),
      null
    );
    assert.equal(titaniumServiceKeyFor("not a url", FORK), null);
  } finally {
    _setSessionForTest(null);
  }
});

test("returns nothing when signed out or unlicensed", () => {
  assert.equal(titaniumServiceKeyFor("https://stt.titaniumlabs.test/v1", FORK), null);
  _setSessionForTest({ getLicenseKey: () => null });
  try {
    assert.equal(titaniumServiceKeyFor("https://stt.titaniumlabs.test/v1", FORK), null);
  } finally {
    _setSessionForTest(null);
  }
});

test("hands the license key to the SERVICES_URL host (web search) and no look-alike host", () => {
  const withServices = { ...FORK, SERVICES_URL: "https://stt.titaniumlabs.us" };
  _setSessionForTest(signedIn);
  try {
    assert.equal(
      titaniumServiceKeyFor("https://stt.titaniumlabs.us/v1/agent/web-search", withServices),
      "key/abc.sig"
    );
    assert.equal(titaniumServiceKeyFor("https://evil.example/x", withServices), null);
    assert.equal(
      titaniumServiceKeyFor("https://stt.titaniumlabs.us.evil.example/x", withServices),
      null
    );
    // The default STT host is still allowed beside it.
    assert.equal(
      titaniumServiceKeyFor("https://stt.titaniumlabs.test/v1/audio/transcriptions", withServices),
      "key/abc.sig"
    );
  } finally {
    _setSessionForTest(null);
  }
});

test("an empty SERVICES_URL adds no host", () => {
  _setSessionForTest(signedIn);
  try {
    assert.equal(titaniumServiceKeyFor("https://x.example/y", { ...FORK, SERVICES_URL: "" }), null);
  } finally {
    _setSessionForTest(null);
  }
});
