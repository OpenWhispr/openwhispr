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

// The providers are TypeScript, so node --test can't require them. Assert the
// wiring from source the way inferenceProviderIds.test.js parses PROVIDER_REGISTRY.
test("chat-completions and openai providers fail truncated replies", () => {
  const reasoningSrc = fs.readFileSync(
    path.join(__dirname, "../../src/services/ReasoningService.ts"),
    "utf8"
  );
  const reasoningGuard = reasoningSrc.match(
    /if \(isTruncatedFinishReason\(choice\?\.finish_reason\)\) \{[\s\S]*?throw new Error/
  );
  assert.ok(reasoningGuard, "callChatCompletionsApi must throw on finish_reason length");

  const openaiSrc = fs.readFileSync(
    path.join(__dirname, "../../src/services/ai/inferenceProviders/openai.ts"),
    "utf8"
  );
  assert.match(openaiSrc, /isTruncatedFinishReason\(response\.choices\?\.\[0\]\?\.finish_reason\)/);
  assert.match(openaiSrc, /isTruncatedResponsesPayload/);
  const openaiGuard = openaiSrc.match(
    /isTruncatedResponsesPayload\(response\)\)?[\s\S]*?throw new Error/
  );
  assert.ok(openaiGuard, "openai provider must throw on truncated chat or responses payloads");
});
