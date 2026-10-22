const test = require("node:test");
const assert = require("node:assert/strict");
const { deferred } = require("./harness/deferred");
const {
  CONNECTED_TTL_MS,
  createConnectionCheckCache,
} = require("../../src/helpers/connectionCheckCache");

const CONFIG = { scope: "reasoning", provider: "openai", apiKey: "sk-made-up", model: "gpt-test" };
const PASS = { success: true };
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };

// A cache on a hand-moved clock, and a provider that gives `answer` and counts each ask.
function setup() {
  let clock = 0;
  const cache = createConnectionCheckCache({ now: () => clock });
  const sent = [];
  const ask = (config, answer = PASS) =>
    cache(config, async () => {
      sent.push(config);
      return answer;
    });
  return { cache, sent, ask, advance: (ms) => (clock += ms) };
}

test("identical checks in flight share one request", async () => {
  const { cache } = setup();
  const answer = deferred();
  let calls = 0;
  const check = () => {
    calls += 1;
    return answer.promise;
  };
  const pending = [cache(CONFIG, check), cache({ ...CONFIG }, check)];
  answer.resolve(PASS);
  assert.deepEqual(await Promise.all(pending), [PASS, PASS]);
  assert.equal(calls, 1);
});

test("every part of a check is part of its identity", async () => {
  const { ask, sent } = setup();
  const variants = [
    CONFIG,
    { ...CONFIG, scope: "transcription" },
    { ...CONFIG, provider: "groq" },
    { ...CONFIG, apiKey: "sk-other" },
    { ...CONFIG, baseUrl: "http://127.0.0.1:1234/v1" },
    { ...CONFIG, model: "gpt-other" },
    { ...CONFIG, clientId: "corti-id" },
    { ...CONFIG, clientSecret: "corti-secret" },
    { ...CONFIG, environment: "eu" },
    { ...CONFIG, tenant: "acme" },
  ];
  await Promise.all(variants.map((config) => ask(config)));
  assert.equal(sent.length, variants.length);
});

test("Connected is reused for ten minutes, then asked again", async () => {
  const { ask, sent, advance } = setup();
  await ask(CONFIG);
  advance(CONNECTED_TTL_MS - 1);
  assert.deepEqual(await ask(CONFIG), PASS);
  assert.equal(sent.length, 1, "a remembered Connected sends nothing");
  advance(1);
  await ask(CONFIG);
  assert.equal(sent.length, 2);
});

test("a failure is never reused, so Retry reaches the provider", async () => {
  const { ask, sent } = setup();
  assert.deepEqual(await ask(CONFIG, REJECTED), REJECTED);
  assert.deepEqual(await ask(CONFIG), PASS);
  assert.equal(sent.length, 2);
});

test("a check that throws is forgotten, and the next ask goes out", async () => {
  const { cache, ask, sent } = setup();
  const broken = () => {
    throw new Error("bridge failed");
  };
  await assert.rejects(cache(CONFIG, broken));
  await ask(CONFIG);
  assert.equal(sent.length, 1);
});
