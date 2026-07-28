const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () => import("../../src/helpers/completionTruncation.js");

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

// Source-level wiring asserts; the TS call sites are not requirable here. See #1341.
test("every guarded provider wires the truncation check and shared failure", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

  const reasoning = read("src/services/ReasoningService.ts");
  assert.match(reasoning, /isTruncatedFinishReason\(choice\?\.finish_reason\)/);
  assert.match(reasoning, /truncatedResponseError\(providerName\)/);

  const openai = read("src/services/ai/inferenceProviders/openai.ts");
  assert.match(openai, /isTruncatedFinishReason\(choice\?\.finish_reason\)/);
  assert.match(openai, /isTruncatedResponsesPayload\(response\)/);
  assert.match(openai, /truncatedResponseError\(providerLabel\)/);

  const tinfoil = read("src/services/ai/inferenceProviders/tinfoil.ts");
  assert.match(tinfoil, /isTruncatedFinishReason\(choice\?\.finish_reason\)/);
  assert.match(tinfoil, /truncatedResponseError\("Tinfoil"\)/);
});
