const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/chatRequestBody.ts");

// Each spec is [status, body]; a fresh Response is minted per call because a
// consumed body can't be re-read. The last spec repeats for later calls.
function jsonResponse(status, body) {
  return [status, body];
}

function fetcher(...specs) {
  const calls = [];
  const doFetch = () => {
    calls.push(1);
    const [status, body] = specs[Math.min(calls.length - 1, specs.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  doFetch.count = () => calls.length;
  return doFetch;
}

// Rejections are remembered per endpoint for the module's lifetime, so each
// test talks to its own endpoint.
let endpoints = 0;
const nextEndpoint = () => `https://host-${++endpoints}.example/v1/chat/completions`;

test("2xx passes through with a single attempt", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(200, { ok: true }));
  const body = { reasoning: { effort: "none" } };

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, () =>
    assert.fail("no fallback")
  );
  assert.equal(res.status, 200);
  assert.equal(doFetch.count(), 1);
  assert.ok(body.reasoning, "body untouched on success");
});

test("400 with a reasoning object strips it blind and retries (old Ollama proxies)", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(400, { error: "bad request" }), jsonResponse(200, {}));
  const body = { reasoning: { effort: "none" }, max_tokens: 10 };
  const logged = [];

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, (d) => logged.push(d));
  assert.equal(res.status, 200);
  assert.equal(doFetch.count(), 2);
  assert.ok(!("reasoning" in body));
  assert.deepEqual(logged, [{ status: 400, stripped: ["reasoning"] }]);
});

test("400 naming a shaped param strips exactly that param and retries (#1611 class)", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(
    jsonResponse(400, { error: "Harmony does not support reasoning_effort='none'" }),
    jsonResponse(200, {})
  );
  const body = { reasoning_effort: "none", chat_template_kwargs: {}, max_tokens: 10 };
  const logged = [];

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, (d) => logged.push(d));
  assert.equal(res.status, 200);
  assert.ok(!("reasoning_effort" in body));
  assert.ok("chat_template_kwargs" in body, "unnamed params stay");
  assert.ok("max_tokens" in body, "token cap is never stripped");
  assert.deepEqual(logged, [{ status: 400, stripped: ["reasoning_effort"] }]);
});

test("422 naming temperature strips it (#1417 class)", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(
    jsonResponse(422, { error: "`temperature` is deprecated for this model" }),
    jsonResponse(200, {})
  );
  const body = { temperature: 0.3, max_tokens: 10 };

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, () => {});
  assert.equal(res.status, 200);
  assert.ok(!("temperature" in body));
});

test("400 naming nothing strippable returns the failure without retrying", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(400, { error: "model not found" }));
  const body = { max_tokens: 10 };

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, () =>
    assert.fail("no fallback")
  );
  assert.equal(res.status, 400);
  assert.equal(doFetch.count(), 1);
});

test("the ladder is bounded: at most two retries even when everything fails", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(400, { error: "reasoning_effort and thinking rejected" }));
  const body = { reasoning: {}, reasoning_effort: "low", thinking: { type: "disabled" } };

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, () => {});
  assert.equal(res.status, 400);
  assert.equal(doFetch.count(), 3);
});

test("non-4xx server errors never trigger stripping", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(500, { error: "reasoning_effort exploded" }));
  const body = { reasoning_effort: "low" };

  const res = await fetchWithParamFallback(nextEndpoint(), doFetch, body, () =>
    assert.fail("no fallback")
  );
  assert.equal(res.status, 500);
  assert.equal(doFetch.count(), 1);
  assert.ok("reasoning_effort" in body);
});

const REASONING_REJECTED = { error: { message: "Unsupported parameter: 'reasoning.effort'" } };

test("a value the retry proved rejected is left out of later requests", async () => {
  const { fetchWithParamFallback } = await load();
  const endpoint = nextEndpoint();
  const rejecting = fetcher(jsonResponse(400, REASONING_REJECTED), jsonResponse(200, {}));
  await fetchWithParamFallback(
    endpoint,
    rejecting,
    { model: "m", reasoning: { effort: "none" } },
    () => {}
  );

  const doFetch = fetcher(jsonResponse(200, {}));
  const body = { model: "m", reasoning: { effort: "none" }, max_tokens: 10 };
  const logged = [];
  const res = await fetchWithParamFallback(endpoint, doFetch, body, (d) => logged.push(d));
  assert.equal(res.status, 200);
  assert.equal(doFetch.count(), 1);
  assert.ok(!("reasoning" in body));
  assert.ok("max_tokens" in body);
  assert.deepEqual(logged, [{ stripped: ["reasoning"], remembered: true }]);
});

test("another value, model or endpoint is still sent after a rejection", async () => {
  const { fetchWithParamFallback } = await load();
  const endpoint = nextEndpoint();
  await fetchWithParamFallback(
    endpoint,
    fetcher(jsonResponse(400, REASONING_REJECTED), jsonResponse(200, {})),
    { model: "m", reasoning: { effort: "none" } },
    () => {}
  );

  for (const [target, body] of [
    [endpoint, { model: "m", reasoning: { effort: "low" } }],
    [endpoint, { model: "other", reasoning: { effort: "none" } }],
    [nextEndpoint(), { model: "m", reasoning: { effort: "none" } }],
  ]) {
    await fetchWithParamFallback(target, fetcher(jsonResponse(200, {})), body, () => {});
    assert.ok("reasoning" in body, JSON.stringify(body));
  }
});

test("a named param is remembered once the retry without it succeeds", async () => {
  const { fetchWithParamFallback } = await load();
  const endpoint = nextEndpoint();
  await fetchWithParamFallback(
    endpoint,
    fetcher(
      jsonResponse(400, { error: "Unrecognized request argument: chat_template_kwargs" }),
      jsonResponse(200, {})
    ),
    { model: "m", reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } },
    () => {}
  );

  const body = {
    model: "m",
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
  };
  const doFetch = fetcher(jsonResponse(200, {}));
  const logged = [];
  await fetchWithParamFallback(endpoint, doFetch, body, (d) => logged.push(d));
  assert.equal(doFetch.count(), 1);
  assert.deepEqual(logged, [{ stripped: ["chat_template_kwargs"], remembered: true }]);
  assert.ok(!("chat_template_kwargs" in body));
  assert.equal(body.reasoning_effort, "none", "only the rejected param is left out");
});

test("a rejection that doesn't name reasoning is not remembered", async () => {
  // It may have come from one of several backends behind the same endpoint.
  const { fetchWithParamFallback } = await load();
  const endpoint = nextEndpoint();
  await fetchWithParamFallback(
    endpoint,
    fetcher(jsonResponse(400, { error: "bad request" }), jsonResponse(200, {})),
    { model: "m", reasoning: { effort: "none" } },
    () => {}
  );

  const body = { model: "m", reasoning: { effort: "none" } };
  await fetchWithParamFallback(endpoint, fetcher(jsonResponse(200, {})), body, () => {});
  assert.ok("reasoning" in body);
});

test("an error naming Reasoning in any case is remembered", async () => {
  const { fetchWithParamFallback } = await load();
  const endpoint = nextEndpoint();
  await fetchWithParamFallback(
    endpoint,
    fetcher(
      jsonResponse(400, { error: "Reasoning is not supported for this model" }),
      jsonResponse(200, {})
    ),
    { model: "m", reasoning: { effort: "none" } },
    () => {}
  );

  const body = { model: "m", reasoning: { effort: "none" } };
  const doFetch = fetcher(jsonResponse(200, {}));
  await fetchWithParamFallback(endpoint, doFetch, body, () => {});
  assert.ok(!("reasoning" in body));
  assert.equal(doFetch.count(), 1);
});

test("OpenRouter rejections are never remembered: each request may reach another upstream", async () => {
  const { fetchWithParamFallback } = await load();
  const endpoint = "https://openrouter.ai/api/v1/chat/completions";
  await fetchWithParamFallback(
    endpoint,
    fetcher(jsonResponse(400, REASONING_REJECTED), jsonResponse(200, {})),
    { model: "m", reasoning: { effort: "high" } },
    () => {}
  );

  const body = { model: "m", reasoning: { effort: "high" } };
  await fetchWithParamFallback(endpoint, fetcher(jsonResponse(200, {})), body, () => {});
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("a remembered rejection expires after ten minutes", async (t) => {
  const { fetchWithParamFallback } = await load();
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const endpoint = nextEndpoint();
  await fetchWithParamFallback(
    endpoint,
    fetcher(jsonResponse(400, REASONING_REJECTED), jsonResponse(200, {})),
    { model: "m", reasoning: { effort: "none" } },
    () => {}
  );

  t.mock.timers.tick(10 * 60 * 1000 - 1);
  const stillRemembered = { model: "m", reasoning: { effort: "none" } };
  await fetchWithParamFallback(endpoint, fetcher(jsonResponse(200, {})), stillRemembered, () => {});
  assert.ok(!("reasoning" in stillRemembered));

  t.mock.timers.tick(1);
  const expired = { model: "m", reasoning: { effort: "none" } };
  await fetchWithParamFallback(endpoint, fetcher(jsonResponse(200, {})), expired, () => {});
  assert.ok("reasoning" in expired);
});

test("nothing is remembered when the retry fails too", async () => {
  const { fetchWithParamFallback } = await load();
  const endpoint = nextEndpoint();
  await fetchWithParamFallback(
    endpoint,
    fetcher(jsonResponse(400, REASONING_REJECTED)),
    { model: "m", reasoning: { effort: "none" } },
    () => {}
  );

  const body = { model: "m", reasoning: { effort: "none" } };
  await fetchWithParamFallback(endpoint, fetcher(jsonResponse(200, {})), body, () => {});
  assert.ok("reasoning" in body);
});
