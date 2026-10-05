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

test("2xx passes through with a single attempt", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(200, { ok: true }));
  const body = { reasoning: { effort: "none" } };

  const res = await fetchWithParamFallback(doFetch, body, () => assert.fail("no fallback"));
  assert.equal(res.status, 200);
  assert.equal(doFetch.count(), 1);
  assert.ok(body.reasoning, "body untouched on success");
});

test("400 with a reasoning object strips it blind and retries (old Ollama proxies)", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(400, { error: "bad request" }), jsonResponse(200, {}));
  const body = { reasoning: { effort: "none" }, max_tokens: 10 };
  const logged = [];

  const res = await fetchWithParamFallback(doFetch, body, (d) => logged.push(d));
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

  const res = await fetchWithParamFallback(doFetch, body, (d) => logged.push(d));
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

  const res = await fetchWithParamFallback(doFetch, body, () => {});
  assert.equal(res.status, 200);
  assert.ok(!("temperature" in body));
});

test("400 naming nothing strippable returns the failure without retrying", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(400, { error: "model not found" }));
  const body = { max_tokens: 10 };

  const res = await fetchWithParamFallback(doFetch, body, () => assert.fail("no fallback"));
  assert.equal(res.status, 400);
  assert.equal(doFetch.count(), 1);
});

test("the ladder is bounded: at most two retries even when everything fails", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(400, { error: "reasoning_effort and thinking rejected" }));
  const body = { reasoning: {}, reasoning_effort: "low", thinking: { type: "disabled" } };

  const res = await fetchWithParamFallback(doFetch, body, () => {});
  assert.equal(res.status, 400);
  assert.equal(doFetch.count(), 3);
});

test("non-4xx server errors never trigger stripping", async () => {
  const { fetchWithParamFallback } = await load();
  const doFetch = fetcher(jsonResponse(500, { error: "reasoning_effort exploded" }));
  const body = { reasoning_effort: "low" };

  const res = await fetchWithParamFallback(doFetch, body, () => assert.fail("no fallback"));
  assert.equal(res.status, 500);
  assert.equal(doFetch.count(), 1);
  assert.ok("reasoning_effort" in body);
});
