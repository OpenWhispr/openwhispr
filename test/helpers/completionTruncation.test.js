const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/completionTruncation.ts");

test("responses payload cut at max_output_tokens is truncated", async () => {
  const { isTruncatedResponsesPayload } = await load();
  assert.ok(
    isTruncatedResponsesPayload({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    })
  );
});

test("completed or otherwise-incomplete responses payloads are not truncated", async () => {
  const { isTruncatedResponsesPayload } = await load();
  assert.ok(!isTruncatedResponsesPayload({ status: "completed" }));
  assert.ok(
    !isTruncatedResponsesPayload({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    })
  );
  assert.ok(!isTruncatedResponsesPayload({ status: "incomplete" }));
  assert.ok(!isTruncatedResponsesPayload(undefined));
});

test("truncatedResponseError names the provider and the token limit", async () => {
  const { truncatedResponseError } = await load();
  const error = truncatedResponseError("Groq");
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Groq hit the token limit and returned a truncated response");
});
