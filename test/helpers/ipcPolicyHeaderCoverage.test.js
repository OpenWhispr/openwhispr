const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inspectDirectOpenWhisprApiCalls } = require("../lib/ipcPolicyHeaderInventory");

const helpersDirectory = path.join(__dirname, "../../src/helpers");
const source = fs.readFileSync(path.join(helpersDirectory, "ipcHandlers.js"), "utf8");
const helperSources = fs
  .readdirSync(helpersDirectory)
  .filter((fileName) => fileName.endsWith(".js"))
  .map((fileName) => ({
    fileName,
    source: fs.readFileSync(path.join(helpersDirectory, fileName), "utf8"),
  }));

const NON_POLICY_ROUTE_REASONS = new Map([
  ["streaming-usage", "usage accounting does not perform a policy-gated action"],
  ["usage", "entitlement and recovery status must remain available"],
  ["stripe/switch-plan", "billing recovery must remain available"],
  ["stripe/preview-switch", "billing recovery must remain available"],
  ["referrals/stats", "referral data is outside the policy capability surface"],
  ["referrals/invite", "referral actions are outside the policy capability surface"],
  ["referrals/invites", "referral data is outside the policy capability surface"],
]);

test("all OpenWhispr multipart transcription transports use policy headers", () => {
  assert.match(source, /async function chunkedCloudTranscribe\([\s\S]*?policyHeaders/);
  assert.doesNotMatch(source, /postMultipart\(url, body, boundary, authHeader/);
  assert.doesNotMatch(source, /chunkedCloudTranscribe\(\{[\s\S]{0,300}?\bauthHeader,/);
  assert.ok(
    (
      source.match(
        /postMultipart\(\s*url,\s*body,\s*boundary,\s*(?:policyHeaders|withPolicyHeaders\(authHeader\))/g
      ) ?? []
    ).length >= 4
  );
});

test("the shared realtime-token helper applies policy headers", () => {
  assert.match(
    source,
    /const postServerToken[\s\S]{0,900}?headers:\s*withPolicyHeaders\(/,
    "the shared realtime-token helper must apply policy headers"
  );
});

test("the structural inventory discovers newly added unprotected API routes", () => {
  const fixture = [
    "proxyFetch(`${apiUrl}/api/reason`, { headers: withPolicyHeaders(authHeader) });",
    "proxyFetch(`${apiUrl}/api/new-route`, { headers: authHeader });",
    "proxyFetch(`${identity.apiUrl}/api/workspace-policy`, { headers: withPolicyRequestHeaders(authHeader) });",
    'proxyFetch("https://api.openai.com/v1/audio/transcriptions", { headers: authHeader });',
  ].join("\n");

  assert.deepEqual(inspectDirectOpenWhisprApiCalls(fixture, "fixture.js"), [
    { fileName: "fixture.js", line: 1, route: "reason", hasPolicyHeaders: true },
    { fileName: "fixture.js", line: 2, route: "new-route", hasPolicyHeaders: false },
    { fileName: "fixture.js", line: 3, route: "workspace-policy", hasPolicyHeaders: true },
  ]);
});

test("every direct OpenWhispr API route is policy-protected or explicitly exempt", () => {
  const calls = helperSources.flatMap(({ fileName, source: helperSource }) =>
    inspectDirectOpenWhisprApiCalls(helperSource, fileName)
  );
  assert.ok(calls.length > 0, "the helper inventory must discover OpenWhispr API calls");

  const unclassified = calls
    .filter((call) => !call.hasPolicyHeaders && !NON_POLICY_ROUTE_REASONS.has(call.route))
    .map((call) => `${call.fileName}:${call.line} /api/${call.route}`);
  assert.deepEqual(
    unclassified,
    [],
    "new direct OpenWhispr routes must use policy headers or declare a non-policy reason"
  );

  const unusedExemptions = [...NON_POLICY_ROUTE_REASONS.keys()].filter(
    (route) => !calls.some((call) => call.route === route && !call.hasPolicyHeaders)
  );
  assert.deepEqual(unusedExemptions, [], "remove stale non-policy route exemptions");
});

test("policy headers are not injected into BYOK or self-hosted transports", () => {
  for (const anchor of ['provider === "tinfoil"', 'kind === "self-hosted"']) {
    const anchorIndex = source.indexOf(anchor);
    assert.notEqual(anchorIndex, -1, `anchor ${anchor} must exist in ipcHandlers.js`);
    assert.doesNotMatch(source.slice(anchorIndex, anchorIndex + 1200), /withPolicyHeaders/);
  }
});
