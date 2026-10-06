const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/queryResult.js");

const INVALID = {
  status: "failed",
  errorCode: "invalid_result",
  message: "Couldn't read the results.",
};
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("an ok result keeps well-formed items and fields as they are", async () => {
  const { normalizeQueryResult } = await load();
  const item = {
    reference: "ENG-1",
    title: "Fix login",
    state: "Todo",
    url: "https://linear.test/ENG-1",
    priority: 2,
    isPullRequest: false,
    assignee: null,
    labels: ["bug", "auth"],
    snippet: "Line one\n\tindented",
  };

  assert.deepEqual(normalizeQueryResult({ status: "ok", items: [item] }), {
    status: "ok",
    items: [item],
    truncated: false,
  });
});

test("at most 20 items; a longer list, or a connector that says so, is marked cut", async () => {
  const { normalizeQueryResult } = await load();
  const items = Array.from({ length: 25 }, (_, index) => ({ reference: `ENG-${index}` }));

  const result = normalizeQueryResult({ status: "ok", items });
  assert.equal(result.items.length, 20);
  assert.equal(result.items.at(-1).reference, "ENG-19");
  assert.equal(result.truncated, true);

  assert.equal(
    normalizeQueryResult({ status: "ok", items: [{ a: 1 }], truncated: true }).truncated,
    true
  );
});

test("values and names that can't be shown are dropped, and so is an item left empty", async () => {
  const { normalizeQueryResult } = await load();
  const result = normalizeQueryResult({
    status: "ok",
    items: [
      null,
      "ENG-1",
      ["ENG-2"],
      JSON.parse('{"__proto__":"x","1bad":"y","has space":"z","_x":"w","x-y":"v"}'),
      { nested: { a: 1 }, fn() {}, notANumber: NaN, huge: Infinity, missing: undefined },
      { title: "kept", ["a".repeat(40)]: 1, ["b".repeat(41)]: 2, x_1: 3 },
    ],
  });

  assert.deepEqual(result.items, [{ title: "kept", ["a".repeat(40)]: 1, x_1: 3 }]);
  assert.equal(result.truncated, false, "dropping malformed values isn't a cut");
  assert.equal(Object.getPrototypeOf(result.items[0]), Object.prototype);
});

test("at most 16 fields per item, in the item's own order", async () => {
  const { normalizeQueryResult } = await load();
  const item = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, index]));

  const result = normalizeQueryResult({ status: "ok", items: [item] });
  assert.deepEqual(
    Object.keys(result.items[0]),
    Array.from({ length: 16 }, (_, index) => `f${index}`)
  );
  assert.equal(result.truncated, true);
});

test("strings lose control characters except newline and tab, and are cut at 1,000", async () => {
  const { normalizeQueryResult } = await load();
  const clean = normalizeQueryResult({
    status: "ok",
    items: [{ title: "a\u0000b\r\nc\td\u001b[31m", exact: "x".repeat(1000) }],
  });
  assert.deepEqual(clean.items[0], { title: "ab\nc\td[31m", exact: "x".repeat(1000) });
  assert.equal(clean.truncated, false);

  const long = normalizeQueryResult({ status: "ok", items: [{ body: "y".repeat(1500) }] });
  assert.equal(long.items[0].body.length, 1000);
  assert.ok(long.items[0].body.endsWith("…"));
  assert.equal(long.truncated, true);
});

test("strings lose characters that hide text, but keep the joiners words and emoji need", async () => {
  const { normalizeQueryResult } = await load();
  const hidden = [
    "\u007f", // DEL
    "\u009b", // 8-bit CSI
    "\u0085", // NEL
    "\u202e", // right-to-left override
    "\u2066", // left-to-right isolate
    "\u200f\u061c", // right-to-left and Arabic letter marks
    "\ufff9\ufffa\ufffb", // interlinear annotation, which hides its text
    "\u206a", // deprecated format control
    "\u200b", // zero-width space
    "\u2060", // word joiner
    "\ufeff", // BOM
    "\u{e0049}\u{e0067}", // tag characters: hidden "Ig"
  ].join("");
  const clean = normalizeQueryResult({
    status: "ok",
    items: [
      {
        title: `Fix${hidden} login`,
        body: "one\u2028two\u2029three",
        persian: "می\u200cخواهم",
        family: "👩\u200d👧",
      },
    ],
  });

  assert.deepEqual(clean.items[0], {
    title: "Fix login",
    body: "one\ntwo\nthree",
    persian: "می\u200cخواهم",
    family: "👩\u200d👧",
  });
  assert.equal(clean.truncated, false);
});

test("a cut never splits a surrogate pair", async () => {
  const { normalizeQueryResult } = await load();
  const result = normalizeQueryResult({
    status: "ok",
    items: [
      {
        body: "a".repeat(998) + "😀" + "b".repeat(10),
        labels: ["c".repeat(198) + "😀" + "d"],
      },
    ],
  });

  const { body, labels } = result.items[0];
  assert.ok(body.length <= 1000);
  assert.ok(labels[0].length <= 200);
  assert.doesNotMatch(body, LONE_SURROGATE);
  assert.doesNotMatch(labels[0], LONE_SURROGATE);
  assert.ok(body.endsWith("…") && labels[0].endsWith("…"));
});

test("lists keep up to 20 strings of at most 200 characters", async () => {
  const { normalizeQueryResult } = await load();
  const labels = [...Array.from({ length: 25 }, (_, index) => `l${index}`), 7, null];

  const result = normalizeQueryResult({ status: "ok", items: [{ labels }] });
  assert.deepEqual(
    result.items[0].labels,
    Array.from({ length: 20 }, (_, index) => `l${index}`)
  );
  assert.equal(result.truncated, true);

  const long = normalizeQueryResult({ status: "ok", items: [{ labels: ["z".repeat(300)] }] });
  assert.equal(long.items[0].labels[0].length, 200);
  assert.equal(long.truncated, true);
});

test("a clarification keeps its message and up to 20 short candidates", async () => {
  const { normalizeQueryResult } = await load();
  const candidates = [...Array.from({ length: 25 }, (_, index) => `ENG team ${index}`), 3];

  const result = normalizeQueryResult({
    status: "needs_clarification",
    message: "Which team? " + "m".repeat(1200),
    candidates,
  });
  assert.equal(result.status, "needs_clarification");
  assert.equal(result.message.length, 1000);
  assert.deepEqual(result.candidates, candidates.slice(0, 20));

  assert.deepEqual(normalizeQueryResult({ status: "needs_clarification" }), INVALID);
  assert.deepEqual(
    normalizeQueryResult({ status: "needs_clarification", message: "Which?" }).candidates,
    []
  );
});

test("a failure keeps its code and message, with defaults", async () => {
  const { normalizeQueryResult, queryFailed } = await load();

  assert.deepEqual(normalizeQueryResult({ status: "failed" }), queryFailed());
  assert.deepEqual(
    normalizeQueryResult({
      status: "failed",
      errorCode: "rate_limited",
      message: "Linear is busy.",
    }),
    { status: "failed", errorCode: "rate_limited", message: "Linear is busy." }
  );
  assert.notEqual(queryFailed(), queryFailed(), "callers can't mutate a shared object");
});

test("a failure's errorCode reaches a log line uncapped, so only a short flat token passes through", async () => {
  const { normalizeQueryResult } = await load();

  // Well-formed codes pass through as-is, transport codes included, so the
  // tool step can show the network copy.
  for (const errorCode of ["rate_limited", "ECONNRESET", "UND_ERR_SOCKET"]) {
    assert.equal(normalizeQueryResult({ status: "failed", errorCode }).errorCode, errorCode);
  }

  // Anything else falls back, so a connector can't smuggle arbitrary text
  // into the log line that prints errorCode uncapped.
  for (const errorCode of [
    "rate limited", // spaces
    "rate-limited", // punctuation
    "https://evil.test/x", // URL-shaped
    "a".repeat(65), // longer than 64
  ]) {
    assert.equal(
      normalizeQueryResult({ status: "failed", errorCode }).errorCode,
      "query_failed",
      errorCode
    );
  }

  // Exactly 64 characters is still allowed.
  assert.equal(
    normalizeQueryResult({ status: "failed", errorCode: "a".repeat(64) }).errorCode,
    "a".repeat(64)
  );
});

test("anything else is malformed", async () => {
  const { normalizeQueryResult } = await load();
  for (const result of [
    undefined,
    null,
    {},
    "ok",
    { status: "ok" },
    { status: "ok", items: "ENG-1" },
    { status: "sent" },
  ]) {
    assert.deepEqual(normalizeQueryResult(result), INVALID, JSON.stringify(result));
  }
});
