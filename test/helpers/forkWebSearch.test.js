const test = require("node:test");
const assert = require("node:assert/strict");
const { forkWebSearch } = require("../../src/helpers/forkWebSearch");

const SERVICES = "https://stt.titaniumlabs.us";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("without a license key it answers AUTH_REQUIRED and never calls the network", async () => {
  const fetchImpl = fakeFetch(() => json(200, { results: [] }));
  const out = await forkWebSearch(
    { servicesUrl: SERVICES, getKey: () => null, fetchImpl },
    "cats",
    5
  );
  assert.equal(out.success, false);
  assert.equal(out.code, "AUTH_REQUIRED");
  assert.equal(fetchImpl.calls.length, 0);
});

test("posts to /v1/agent/web-search with the license key as bearer and returns results", async () => {
  const results = [{ title: "T", url: "https://e.test", text: "x", publishedDate: null }];
  const asked = [];
  const fetchImpl = fakeFetch(() => json(200, { results }));
  const out = await forkWebSearch(
    {
      servicesUrl: `${SERVICES}/`,
      getKey: (url) => {
        asked.push(url);
        return "key/abc.sig";
      },
      fetchImpl,
    },
    "cats",
    3
  );
  assert.deepEqual(out, { success: true, results });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, `${SERVICES}/v1/agent/web-search`);
  assert.deepEqual(asked, [url], "the key is requested for the exact URL it is sent to");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer key/abc.sig");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { query: "cats", numResults: 3 });
  assert.equal(init.credentials, undefined);
  assert.equal(init.headers.Cookie, undefined);
});

test("status codes map to stable error codes", async () => {
  const cases = [
    [401, "AUTH_EXPIRED"],
    [403, "AUTH_EXPIRED"],
    [429, "RATE_LIMITED"],
    [500, "SERVER_ERROR"],
    [502, "SERVER_ERROR"],
    [503, "SERVER_ERROR"],
    [504, "SERVER_ERROR"],
    [400, "REQUEST_REJECTED"],
  ];
  for (const [status, code] of cases) {
    const fetchImpl = fakeFetch(() =>
      json(status, { error: { code: "x", message: "from server" } })
    );
    const out = await forkWebSearch(
      { servicesUrl: SERVICES, getKey: () => "k", fetchImpl },
      "q",
      5
    );
    assert.equal(out.success, false, String(status));
    assert.equal(out.code, code, String(status));
    assert.equal(fetchImpl.calls.length, 1, "no retry");
  }
});

test("a network error is SERVER_ERROR with no retry and no second URL", async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error("ECONNRESET secret-host.internal");
  });
  const out = await forkWebSearch({ servicesUrl: SERVICES, getKey: () => "k", fetchImpl }, "q", 5);
  assert.equal(out.code, "SERVER_ERROR");
  assert.equal(fetchImpl.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(out), /secret-host/);
});

test("the server's error message is passed through for 5xx, and the query is never echoed", async () => {
  const fetchImpl = fakeFetch(() =>
    json(503, { error: { code: "web_search_unconfigured", message: "Web search is unavailable" } })
  );
  const out = await forkWebSearch(
    { servicesUrl: SERVICES, getKey: () => "k", fetchImpl },
    "private query text",
    5
  );
  assert.equal(out.error, "Web search is unavailable");
  assert.doesNotMatch(JSON.stringify(out), /private query text/);
});

test("an empty services URL is a configuration error and calls nothing", async () => {
  const fetchImpl = fakeFetch(() => json(200, { results: [] }));
  const out = await forkWebSearch({ servicesUrl: "", getKey: () => "k", fetchImpl }, "q", 5);
  assert.equal(out.success, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test("a 200 without a results array yields an empty list, not a crash", async () => {
  const fetchImpl = fakeFetch(() => json(200, {}));
  const out = await forkWebSearch({ servicesUrl: SERVICES, getKey: () => "k", fetchImpl }, "q", 5);
  assert.deepEqual(out, { success: true, results: [] });
});

test("a non-https or userinfo services URL is refused before any key lookup or request", async () => {
  for (const servicesUrl of [
    "http://stt.titaniumlabs.us",
    "ftp://stt.titaniumlabs.us",
    "https://stt.titaniumlabs.us@evil.example",
    "not a url",
  ]) {
    let asked = 0;
    const fetchImpl = fakeFetch(() => json(200, { results: [] }));
    const out = await forkWebSearch(
      {
        servicesUrl,
        getKey: () => {
          asked += 1;
          return "k";
        },
        fetchImpl,
      },
      "q",
      5
    );
    assert.equal(out.success, false, servicesUrl);
    assert.equal(out.code, "SERVER_ERROR", servicesUrl);
    assert.equal(asked, 0, servicesUrl);
    assert.equal(fetchImpl.calls.length, 0, servicesUrl);
  }
});
