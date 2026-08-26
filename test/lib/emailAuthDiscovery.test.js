const assert = require("node:assert/strict");
const test = require("node:test");

const { discoverEmailAuth } = require("../../src/lib/emailAuthDiscovery.ts");

function installFetch(t, implementation) {
  const previousFetch = global.fetch;
  global.fetch = implementation;
  t.after(() => {
    global.fetch = previousFetch;
  });
}

test("email discovery preserves the auth base URL and SSO routing", async (t) => {
  let request;
  installFetch(t, async (input, init) => {
    request = { input, init };
    return new Response(
      JSON.stringify({
        exists: true,
        sso: { available: true, required: false, domain: "example.com" },
      })
    );
  });

  const result = await discoverEmailAuth(
    "  returning@example.com  ",
    "https://auth.example.test/custom/path"
  );

  assert.equal(String(request.input), "https://auth.example.test/custom/path/api/check-user");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { email: "returning@example.com" });
  assert.deepEqual(result, {
    exists: true,
    sso: { available: true, required: false, domain: "example.com" },
  });
});

test("email discovery accepts the legacy response without SSO metadata", async (t) => {
  installFetch(t, async () => new Response(JSON.stringify({ exists: false })));

  assert.deepEqual(await discoverEmailAuth("new@example.com", "https://auth.example.test"), {
    exists: false,
  });
});

test("email discovery treats the sso block as advisory", async (t) => {
  const lenientCases = [
    [
      { exists: true, sso: { available: true } },
      { exists: true, sso: { available: true, required: false } },
    ],
    [
      { exists: true, sso: { available: true, required: "no", domain: 42 } },
      { exists: true, sso: { available: true, required: false } },
    ],
    [{ exists: false, sso: { available: false } }, { exists: false }],
    [{ exists: true, sso: null }, { exists: true }],
  ];
  let payload;
  installFetch(t, async () => new Response(JSON.stringify(payload)));
  for (const [response, expected] of lenientCases) {
    payload = response;
    assert.deepEqual(
      await discoverEmailAuth("user@example.com", "https://auth.example.test"),
      expected
    );
  }
});

test("email discovery reports a missing endpoint as unavailable", async (t) => {
  installFetch(t, async () => new Response("not found", { status: 404 }));

  assert.equal(await discoverEmailAuth("user@example.com", "https://auth.example.test"), null);
});

test("email discovery rejects failed and malformed responses", async (t) => {
  installFetch(t, async () => new Response("service unavailable", { status: 503 }));
  await assert.rejects(discoverEmailAuth("user@example.com", "https://auth.example.test"), {
    message: "Email account discovery failed with status 503",
  });

  const invalidPayloads = [{}, { exists: "yes" }];
  for (const payload of invalidPayloads) {
    global.fetch = async () => new Response(JSON.stringify(payload));
    await assert.rejects(discoverEmailAuth("user@example.com", "https://auth.example.test"), {
      message: "Email account discovery returned an invalid response",
    });
  }

  global.fetch = async () => new Response("not json");
  await assert.rejects(discoverEmailAuth("user@example.com", "https://auth.example.test"), {
    message: "Email account discovery returned an invalid response",
  });
});
