const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/services/ai/apiErrorMessage.ts");

test("a mistral 422 validation body names every rejected field instead of [object Object]", async () => {
  const { extractApiErrorMessage } = await load();

  const body = {
    object: "error",
    message: {
      detail: [
        {
          type: "extra_forbidden",
          loc: ["body", "max_completion_tokens"],
          msg: "Extra inputs are not permitted",
          input: 4096,
        },
        {
          type: "extra_forbidden",
          loc: ["body", "chat_template_kwargs"],
          msg: "Extra inputs are not permitted",
          input: { enable_thinking: false },
        },
      ],
    },
    type: "invalid_request_error",
  };

  const message = extractApiErrorMessage(body, "fallback");

  assert.equal(
    message,
    "max_completion_tokens: Extra inputs are not permitted; chat_template_kwargs: Extra inputs are not permitted"
  );
  assert.ok(!message.includes("[object Object]"));
});

test("the openai error shape returns its nested message", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(
    extractApiErrorMessage({ error: { message: "Invalid API key" } }, "fallback"),
    "Invalid API key"
  );
});

test("a plain string message is returned as is", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(extractApiErrorMessage({ message: "Rate limited" }, "fallback"), "Rate limited");
});

test("an object message without a detail list is stringified rather than coerced", async () => {
  const { extractApiErrorMessage } = await load();

  const message = extractApiErrorMessage({ message: { weird: "object" } }, "fallback");

  assert.equal(message, '{"weird":"object"}');
  assert.ok(!message.includes("[object Object]"));
});

test("a long stringified message is capped", async () => {
  const { extractApiErrorMessage } = await load();

  const message = extractApiErrorMessage({ message: { blob: "x".repeat(2000) } }, "fallback");

  assert.ok(message.length <= 501, `expected a capped message, got ${message.length} chars`);
});

test("detail entries with missing or non-string msg and loc degrade gracefully", async () => {
  const { extractApiErrorMessage } = await load();

  const body = {
    message: {
      detail: [
        { loc: ["body", "field_a"], msg: 42 },
        { loc: [], msg: "Field is required" },
        { loc: ["body", { nested: true }], msg: "Bad nesting" },
        { msg: "No loc at all" },
        "not an object",
        null,
      ],
    },
  };

  assert.equal(
    extractApiErrorMessage(body, "fallback"),
    "Field is required; Bad nesting; No loc at all"
  );
});

test("a detail list with nothing usable still surfaces the raw body over [object Object]", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(extractApiErrorMessage({ message: { detail: [] } }, "fallback"), '{"detail":[]}');
});

test("an error object without a nested message is stringified rather than dropped", async () => {
  const { extractApiErrorMessage } = await load();

  const message = extractApiErrorMessage(
    { error: { code: "invalid_request_error", type: "bad_request" } },
    "fallback"
  );

  assert.equal(message, '{"code":"invalid_request_error","type":"bad_request"}');
  assert.ok(!message.includes("[object Object]"));
});

test("a bare error string is used when there is no message", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(
    extractApiErrorMessage({ error: "Service Unavailable" }, "fallback"),
    "Service Unavailable"
  );
});

test("non-object bodies fall back to the caller's message", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(extractApiErrorMessage(null, "fallback"), "fallback");
  assert.equal(extractApiErrorMessage("just a string", "fallback"), "fallback");
  assert.equal(extractApiErrorMessage([], "fallback"), "fallback");
  assert.equal(extractApiErrorMessage({}, "fallback"), "fallback");
  assert.equal(extractApiErrorMessage(undefined, "fallback"), "fallback");
});

test("an empty fallback still yields a non-empty message", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(extractApiErrorMessage({}, ""), "Unknown API error");
});

test("a fastapi detail string is used when there is no message", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(
    extractApiErrorMessage({ detail: "Model 'llama3' not found" }, "fallback"),
    "Model 'llama3' not found"
  );
});

test("a top-level detail list names every rejected field", async () => {
  const { extractApiErrorMessage } = await load();

  const body = { detail: [{ loc: ["body", "model"], msg: "field required" }] };

  assert.equal(extractApiErrorMessage(body, "fallback"), "model: field required");
});

test("a detail string nested under message is extracted rather than stringified", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(
    extractApiErrorMessage({ message: { detail: "Rate limit exceeded" } }, "fallback"),
    "Rate limit exceeded"
  );
});

test("a detail string nested under error is extracted rather than stringified", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(
    extractApiErrorMessage({ error: { detail: "Rate limit exceeded" } }, "fallback"),
    "Rate limit exceeded"
  );
});

test("a nested detail list beats a top-level detail restating the status", async () => {
  const { extractApiErrorMessage } = await load();

  const body = {
    detail: "Unprocessable Entity",
    message: { detail: [{ loc: ["body", "model"], msg: "field required" }] },
  };

  assert.equal(extractApiErrorMessage(body, "fallback"), "model: field required");
});

test("a top-level detail with nothing usable still surfaces the raw body", async () => {
  const { extractApiErrorMessage } = await load();

  assert.equal(
    extractApiErrorMessage({ detail: { reason: "upstream timeout" } }, "fallback"),
    '{"reason":"upstream timeout"}'
  );
});
