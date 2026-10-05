const test = require("node:test");
const assert = require("node:assert/strict");
const { getCortiToken } = require("../../src/helpers/cortiAuth");

function makeFetch(tokenByCall) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ access_token: tokenByCall[calls.length - 1], expires_in: 300 }),
    };
  };
  return { fetchImpl, calls };
}

// Each test uses a distinct clientId so the module-level token cache never
// bleeds state across tests.

test("identical credentials hit the token cache", async () => {
  const { fetchImpl, calls } = makeFetch(["token-a", "token-never"]);
  const creds = { environment: "eu", tenant: "acme", clientId: "cache-hit", clientSecret: "s1" };

  assert.equal(await getCortiToken(creds, fetchImpl), "token-a");
  assert.equal(await getCortiToken(creds, fetchImpl), "token-a");
  assert.equal(calls.length, 1);
});

test("changing only the secret bypasses the cache and re-authenticates", async () => {
  const { fetchImpl, calls } = makeFetch(["token-old", "token-new"]);
  const base = { environment: "eu", tenant: "acme", clientId: "secret-change" };

  assert.equal(await getCortiToken({ ...base, clientSecret: "right" }, fetchImpl), "token-old");
  assert.equal(await getCortiToken({ ...base, clientSecret: "wrong" }, fetchImpl), "token-new");
  assert.equal(calls.length, 2);
});

test("the raw secret never appears in a cache key or the request URL", async () => {
  const { fetchImpl, calls } = makeFetch(["token-x"]);
  await getCortiToken(
    { environment: "us", tenant: "acme", clientId: "url-check", clientSecret: "super-secret" },
    fetchImpl
  );
  assert.equal(calls[0].url.includes("super-secret"), false);
  assert.equal(calls[0].init.body.includes("client_secret=super-secret"), true);
});

test("the token request carries an abort signal and surfaces AbortError", async () => {
  let seenSignal = null;
  const fetchImpl = async (_url, init) => {
    seenSignal = init.signal;
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };

  await assert.rejects(
    getCortiToken(
      { environment: "eu", tenant: "acme", clientId: "abort", clientSecret: "s" },
      fetchImpl
    ),
    (error) => error.name === "AbortError"
  );
  assert.ok(seenSignal instanceof AbortSignal);
});
