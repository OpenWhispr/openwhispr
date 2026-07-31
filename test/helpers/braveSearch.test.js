const test = require("node:test");
const assert = require("node:assert");

const {
  buildBraveSearchUrl,
  clampResultCount,
  mapBraveResults,
  braveWebSearch,
  stripHtml,
  MAX_RESULTS,
  DEFAULT_RESULTS,
} = require("../../src/helpers/braveSearch");

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}
function errResponse(status) {
  return { ok: false, status, json: async () => ({}) };
}

test("clampResultCount bounds the count Brave will accept", () => {
  assert.equal(clampResultCount(undefined), DEFAULT_RESULTS);
  assert.equal(clampResultCount("not a number"), DEFAULT_RESULTS);
  assert.equal(clampResultCount(0), 1);
  assert.equal(clampResultCount(-3), 1);
  assert.equal(clampResultCount(7), 7);
  assert.equal(clampResultCount(7.9), 7);
  assert.equal(clampResultCount(999), MAX_RESULTS);
});

test("buildBraveSearchUrl encodes the query and clamps count", () => {
  const url = new URL(buildBraveSearchUrl("rust & go?", 999));
  assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
  assert.equal(url.searchParams.get("q"), "rust & go?");
  assert.equal(url.searchParams.get("count"), String(MAX_RESULTS));
});

test("stripHtml removes Brave's markup and decodes entities", () => {
  assert.equal(stripHtml("<strong>Rust</strong> &amp; Go &quot;fast&quot;"), 'Rust & Go "fast"');
  assert.equal(stripHtml(undefined), "");
});

test("mapBraveResults normalises to the webSearchTool shape", () => {
  const mapped = mapBraveResults({
    web: {
      results: [
        {
          title: "<strong>Rust</strong> lang",
          url: "https://rust-lang.org",
          description: "A <strong>systems</strong> language",
          page_age: "2026-01-02T00:00:00Z",
        },
        { title: "No date" },
      ],
    },
  });
  assert.deepEqual(mapped, [
    {
      title: "Rust lang",
      url: "https://rust-lang.org",
      text: "A systems language",
      publishedDate: "2026-01-02T00:00:00Z",
    },
    { title: "No date", url: "", text: "", publishedDate: null },
  ]);
});

test("mapBraveResults tolerates a payload with no web results", () => {
  assert.deepEqual(mapBraveResults({}), []);
  assert.deepEqual(mapBraveResults(null), []);
  assert.deepEqual(mapBraveResults({ web: { results: "nope" } }), []);
});

test("a missing key fails before any request is made", async () => {
  let called = false;
  const result = await braveWebSearch({
    query: "anything",
    apiKey: "",
    fetchImpl: () => {
      called = true;
      throw new Error("should not be reached");
    },
  });
  assert.equal(called, false);
  assert.equal(result.success, false);
  assert.equal(result.code, "API_KEY_MISSING");
});

test("an empty query fails before any request is made", async () => {
  let called = false;
  const fetchImpl = () => {
    called = true;
    throw new Error("should not be reached");
  };
  for (const query of ["", "   ", undefined]) {
    const result = await braveWebSearch({ query, apiKey: "k", fetchImpl });
    assert.equal(result.success, false, `rejected ${JSON.stringify(query)}`);
  }
  assert.equal(called, false);
});

test("the subscription token is sent as a header, never in the URL", async () => {
  let seen = null;
  await braveWebSearch({
    query: "electron",
    numResults: 3,
    apiKey: "brave-secret-token",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return okResponse({ web: { results: [] } });
    },
  });
  assert.equal(seen.init.headers["X-Subscription-Token"], "brave-secret-token");
  assert.equal(seen.init.method, "GET");
  assert.ok(!seen.url.includes("brave-secret-token"), "token must not leak into the query string");
  assert.equal(new URL(seen.url).searchParams.get("count"), "3");
});

test("a successful search returns mapped results", async () => {
  const result = await braveWebSearch({
    query: "electron",
    apiKey: "k",
    fetchImpl: async () =>
      okResponse({
        web: { results: [{ title: "Electron", url: "https://electronjs.org", description: "d" }] },
      }),
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.results, [
    { title: "Electron", url: "https://electronjs.org", text: "d", publishedDate: null },
  ]);
});

test("auth and rate-limit failures carry a distinguishing code", async () => {
  const codeFor = async (status) =>
    (await braveWebSearch({ query: "q", apiKey: "k", fetchImpl: async () => errResponse(status) }))
      .code;

  assert.equal(await codeFor(401), "INVALID_KEY");
  assert.equal(await codeFor(403), "INVALID_KEY");
  assert.equal(await codeFor(429), "PROVIDER_RATE_LIMITED");

  const other = await braveWebSearch({
    query: "q",
    apiKey: "k",
    fetchImpl: async () => errResponse(500),
  });
  assert.equal(other.success, false);
  assert.equal(other.code, undefined);
  assert.match(other.error, /500/);
});
