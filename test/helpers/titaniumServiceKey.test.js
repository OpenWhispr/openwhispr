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

test("the key goes only to an https URL whose exact origin is a configured https origin", () => {
  const config = {
    DEFAULT_STT: { baseUrl: "https://x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us/v1" },
    SERVICES_URL: "https://stt.titaniumlabs.us",
    TITANIUM: { serviceHosts: ["search.titaniumlabs.test"] },
  };
  const cases = [
    // [url, config override, expected key]
    ["https://stt.titaniumlabs.us/v1/audio/transcriptions", {}, "key/abc.sig"],
    ["https://STT.titaniumlabs.us:443/v1/x", {}, "key/abc.sig"],
    [
      "https://x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us/v1/audio/transcriptions",
      {},
      "key/abc.sig",
    ],
    ["https://search.titaniumlabs.test/x", {}, "key/abc.sig"],
    ["http://stt.titaniumlabs.us/v1/x", {}, null],
    ["https://stt.titaniumlabs.us:8443/v1/x", {}, null],
    ["ftp://stt.titaniumlabs.us/v1/x", {}, null],
    ["https://stt.titaniumlabs.us@evil.example/v1/x", {}, null],
    ["https://user:pw@stt.titaniumlabs.us/v1/x", {}, null],
    ["https://stt.titaniumlabs.us.evil.example/v1/x", {}, null],
    ["https://evilstt.titaniumlabs.us/v1/x", {}, null],
    ["http://search.titaniumlabs.test/x", {}, null],
    ["", {}, null],
    // An override that points the configured origin at http allows nothing there.
    ["http://attacker.example/v1/x", { SERVICES_URL: "http://attacker.example" }, null],
    ["https://attacker.example/v1/x", { SERVICES_URL: "http://attacker.example" }, null],
    [
      "http://attacker.example/v1/x",
      { DEFAULT_STT: { baseUrl: "http://attacker.example/v1" } },
      null,
    ],
    // The legacy https host keeps working when SERVICES_URL is overridden to http.
    [
      "https://x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us/v1/x",
      { SERVICES_URL: "http://attacker.example" },
      "key/abc.sig",
    ],
  ];
  _setSessionForTest(signedIn);
  try {
    for (const [url, override, expected] of cases) {
      assert.equal(titaniumServiceKeyFor(url, { ...config, ...override }), expected, url);
    }
  } finally {
    _setSessionForTest(null);
  }
});

test("the default allowlist ignores a runtime VITE_SERVICES_URL override", () => {
  const saved = process.env.VITE_SERVICES_URL;
  process.env.VITE_SERVICES_URL = "https://attacker.example";
  _setSessionForTest(signedIn);
  try {
    assert.equal(titaniumServiceKeyFor("https://attacker.example/v1/agent/web-search"), null);
    assert.equal(
      titaniumServiceKeyFor("https://stt.titaniumlabs.us/v1/agent/web-search"),
      "key/abc.sig"
    );
  } finally {
    _setSessionForTest(null);
    if (saved === undefined) delete process.env.VITE_SERVICES_URL;
    else process.env.VITE_SERVICES_URL = saved;
  }
});
