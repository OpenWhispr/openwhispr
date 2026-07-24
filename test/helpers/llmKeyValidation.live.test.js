const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SUPPORTED_LLM_KEY_PROVIDERS,
  validateLlmApiKey,
} = require("../../src/helpers/llmKeyValidation");

const RUN_LIVE_AUDIT = process.env.OPENWHISPR_LIVE_LLM_KEY_VALIDATION === "1";
const INVALID_AUDIT_KEY = "openwhispr-invalid-key-validation-audit";

test(
  "live provider validation endpoints reject an invalid key",
  { skip: !RUN_LIVE_AUDIT, timeout: 120_000 },
  async (t) => {
    for (const provider of SUPPORTED_LLM_KEY_PROVIDERS) {
      await t.test(provider, { timeout: 20_000 }, async () => {
        const result = await validateLlmApiKey(
          { provider, key: INVALID_AUDIT_KEY },
          { fetchImpl: fetch, timeoutMs: 15_000 }
        );

        assert.equal(result.success, false);
        assert.equal(result.verified, false);
        assert.equal(result.code, "INVALID_KEY");
      });
    }
  }
);
