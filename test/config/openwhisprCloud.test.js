const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_OPENWHISPR_API_URL,
  resolveOpenWhisprApiUrl,
} = require("../../src/config/openwhisprCloud.js");

test("defaults to the official OpenWhispr Cloud API when no override is configured", () => {
  assert.equal(resolveOpenWhisprApiUrl({}), DEFAULT_OPENWHISPR_API_URL);
});

test("prefers explicit OpenWhispr API URL overrides", () => {
  assert.equal(
    resolveOpenWhisprApiUrl({
      OPENWHISPR_API_URL: "https://self-hosted.example.com",
      VITE_OPENWHISPR_API_URL: DEFAULT_OPENWHISPR_API_URL,
    }),
    "https://self-hosted.example.com"
  );
});

test("falls back to Vite OpenWhispr API URL overrides", () => {
  assert.equal(
    resolveOpenWhisprApiUrl({
      VITE_OPENWHISPR_API_URL: "https://vite.example.com",
    }),
    "https://vite.example.com"
  );
});
