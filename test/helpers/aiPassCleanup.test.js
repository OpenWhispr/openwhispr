const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiPassCleanup } = require("../../src/helpers/aiPassCleanup");

const clientId = "test-public-client";
const model = "test-cleanup";
const input = { model, system: "Clean up the dictation.", user: "um lets meet on tuesday" };

function fixture(options = {}) {
  let saved;
  let clock = 100000;
  let allowed = true;
  const calls = [];
  const service = createAiPassCleanup({
    clientId,
    canUse: () => allowed,
    store: {
      read: () => saved,
      write: (tokens) => (saved = tokens),
      clear: () => (saved = null),
    },
    now: () => clock,
    async runOAuth(flow) {
      const redirect = `http://127.0.0.1:${flow.ports[0]}${flow.callbackPath}`;
      const url = new URL(flow.buildAuthUrl(redirect, "local-state", "local-challenge"));
      assert.equal(url.origin + url.pathname, "https://aipass.one/oauth2/authorize");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:43130/auth/aipass/callback",
        scope: "api:access",
        state: "local-state",
        code_challenge: "local-challenge",
        code_challenge_method: "S256",
      });
      assert.equal(flow.requireStateOnError, true);
      return flow.handleCallback("local-code", redirect, "local-verifier");
    },
    async fetch(url, init) {
      const { pathname } = new URL(url);
      calls.push({ url, pathname, init });
      assert.equal(new URL(url).origin, "https://aipass.one");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      if (pathname === "/oauth2/token") {
        const refresh = JSON.parse(init.body).grantType === "refresh_token";
        if (refresh && options.rejectRefresh) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: refresh ? "new-access" : "first-access",
          refresh_token: refresh ? "new-refresh" : "first-refresh",
          expires_in: 60,
        });
      }
      if (pathname === "/v1/models") {
        return Response.json({
          data: [
            {
              id: model,
              name: "Test cleanup model",
              capabilities: ["text"],
              methods: ["chat_completions"],
            },
            { id: "speech", name: "Audio", capabilities: ["audio"], methods: ["transcriptions"] },
          ],
        });
      }
      if (pathname === "/v1/chat/completions") {
        if (options.failPaid) throw new Error("Connection lost");
        return Response.json({
          choices: [
            {
              finish_reason: options.finish || "stop",
              message: { content: "Let's meet on Tuesday." },
            },
          ],
        });
      }
      if (pathname === "/oauth2/revoke") {
        return new Response(null, { status: options.failRevoke ? 503 : 200 });
      }
      assert.fail(`Unexpected provider request ${pathname}`);
    },
  });
  return {
    service,
    calls,
    expire: () => (clock += 60000),
    restrict: () => (allowed = false),
    getTokens: () => saved,
  };
}

test("AI Pass exchanges the OAuth code, discovers a text model, and cleans synthetic dictation", async () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.status(), { configured: true, connected: false });
  await service.connect();
  assert.deepEqual(service.status(), { configured: true, connected: true });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grantType: "authorization_code",
    clientId,
    code: "local-code",
    redirectUri: "http://127.0.0.1:43130/auth/aipass/callback",
    codeVerifier: "local-verifier",
  });
  assert.deepEqual(await service.listModels(), [{ id: model, name: "Test cleanup model" }]);
  assert.equal(await service.complete(input), "Let's meet on Tuesday.");
  assert.match(calls[1].url, /capability=text&method=chat_completions$/);
  const paid = calls.at(-1).init;
  assert.equal(paid.headers.Authorization, "Bearer first-access");
  assert.equal(paid.headers["X-AIPass-OAuth-Client-Id"], clientId);
  assert.deepEqual(JSON.parse(paid.body), {
    model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    stream: false,
    max_completion_tokens: 4096,
  });
  await assert.rejects(service.complete({ ...input, model: "speech" }), /available AI Pass model/);
  assert.equal(calls.filter(({ pathname }) => pathname === "/v1/chat/completions").length, 1);
});

test("concurrent cleanup shares a refresh and disconnect revokes the rotated pair", async () => {
  const { service, calls, expire, getTokens } = fixture();
  await service.connect();
  await service.listModels();
  expire();
  await Promise.all([service.complete(input), service.complete(input)]);
  const tokenCalls = calls.filter(({ pathname }) => pathname === "/oauth2/token");
  assert.equal(tokenCalls.length, 2);
  assert.deepEqual(JSON.parse(tokenCalls[1].init.body), {
    grantType: "refresh_token",
    refreshToken: "first-refresh",
    clientId,
  });
  assert.equal(getTokens().refreshToken, "new-refresh");
  await service.disconnect();
  assert.equal(getTokens(), null);
  const revocations = calls.filter(({ pathname }) => pathname === "/oauth2/revoke");
  assert.deepEqual(
    revocations.map(({ init }) => Object.fromEntries(init.body)),
    [
      { token: "new-refresh", client_id: clientId },
      { token: "new-access", client_id: clientId },
    ]
  );
});

test("an ambiguous paid failure never retries, and truncated output is rejected", async () => {
  for (const options of [{ failPaid: true }, { finish: "length" }]) {
    const { service, calls } = fixture(options);
    await service.connect();
    await assert.rejects(service.complete(input), /Connection lost|incomplete cleanup/);
    assert.equal(calls.filter(({ pathname }) => pathname === "/v1/chat/completions").length, 1);
  }
});

test("invalid refresh disconnects, policy stops outbound requests, and failed revocation clears local tokens", async () => {
  const expired = fixture({ rejectRefresh: true });
  await expired.service.connect();
  expired.expire();
  await assert.rejects(expired.service.complete(input), /authorization failed/);
  assert.equal(expired.service.status().connected, false);

  const blocked = fixture();
  await blocked.service.connect();
  blocked.restrict();
  await assert.rejects(blocked.service.complete(input), /unavailable/);
  assert.equal(blocked.calls.length, 1);

  const revoked = fixture({ failRevoke: true });
  await revoked.service.connect();
  await assert.rejects(revoked.service.disconnect(), /disconnected locally/);
  assert.equal(revoked.getTokens(), null);
});
