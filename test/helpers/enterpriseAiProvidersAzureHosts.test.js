const test = require("node:test");
const assert = require("node:assert/strict");

const { toAzureOpenAIBaseUrl } = require("../../src/helpers/enterpriseAiProviders.js");
const { AZURE_HOST_SUFFIXES } = require("../../src/helpers/enterpriseManagedConfig.mjs");

test("managed Azure LLM accepts every host the envelope validator accepts", () => {
  for (const suffix of AZURE_HOST_SUFFIXES) {
    const endpoint = `https://acme${suffix}`;
    assert.equal(toAzureOpenAIBaseUrl(endpoint), `${endpoint}/openai`, endpoint);
  }
});

test("managed Azure LLM still rejects spoofed and path-qualified hosts", () => {
  for (const endpoint of [
    "https://acme.openai.azure.us",
    "https://services.ai.azure.com",
    "https://acme.openai.azure.com/openai",
    "http://acme.openai.azure.com",
    "https://user:pw@acme.openai.azure.com",
    "https://evil.com/acme.openai.azure.com",
  ]) {
    assert.throws(() => toAzureOpenAIBaseUrl(endpoint), /public Azure resource origin/, endpoint);
  }
});
