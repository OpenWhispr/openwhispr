const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

test("bedrockGeoPrefix maps regions to inference profile geographies", async () => {
  const { bedrockGeoPrefix } = await import("../../src/utils/bedrockRegions.ts");

  assert.equal(bedrockGeoPrefix("us-east-1"), "us");
  assert.equal(bedrockGeoPrefix("us-west-2"), "us");
  assert.equal(bedrockGeoPrefix("ca-central-1"), "us");
  assert.equal(bedrockGeoPrefix("eu-west-2"), "eu");
  assert.equal(bedrockGeoPrefix("eu-central-1"), "eu");
  assert.equal(bedrockGeoPrefix("ap-southeast-1"), "apac");
  assert.equal(bedrockGeoPrefix("ap-northeast-1"), "apac");
});

test("adjustBedrockModelForRegion rewrites geo-prefixed profile IDs", async () => {
  const { adjustBedrockModelForRegion } = await import("../../src/utils/bedrockRegions.ts");

  assert.equal(
    adjustBedrockModelForRegion("us.anthropic.claude-haiku-4-5-20251001-v1:0", "eu-west-2"),
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
  );
  assert.equal(
    adjustBedrockModelForRegion("eu.anthropic.claude-sonnet-4-6", "us-east-1"),
    "us.anthropic.claude-sonnet-4-6"
  );
  assert.equal(
    adjustBedrockModelForRegion("apac.anthropic.claude-opus-4-7", "ap-southeast-2"),
    "apac.anthropic.claude-opus-4-7"
  );
});

test("adjustBedrockModelForRegion leaves on-demand and custom IDs untouched", async () => {
  const { adjustBedrockModelForRegion } = await import("../../src/utils/bedrockRegions.ts");

  assert.equal(
    adjustBedrockModelForRegion("openai.gpt-oss-120b-1:0", "eu-west-2"),
    "openai.gpt-oss-120b-1:0"
  );
  assert.equal(adjustBedrockModelForRegion("deepseek.v3.2", "ap-south-1"), "deepseek.v3.2");
  assert.equal(
    adjustBedrockModelForRegion("amazon.nova-lite-v1:0", "eu-west-2"),
    "amazon.nova-lite-v1:0"
  );
  assert.equal(adjustBedrockModelForRegion("", "eu-west-2"), "");
  assert.equal(
    adjustBedrockModelForRegion("arn:aws:bedrock:eu-west-2:123:inference-profile/x", "eu-west-2"),
    "arn:aws:bedrock:eu-west-2:123:inference-profile/x"
  );
});
