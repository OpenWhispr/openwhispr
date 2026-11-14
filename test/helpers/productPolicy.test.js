const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");
const { productOperationAllowed } = require("../../src/helpers/productPolicy");

test("generic cloud routes enforce backup and sharing policy while permitting erasure", () => {
  const policy = defaultDevicePolicy();
  policy.dataRetention.cloudBackupAllowed = false;
  policy.sharing.externalLinkSharing = "disabled";
  const snapshot = { success: true, managed: true, policy };
  const allowed = (path, method, body) =>
    productOperationAllowed(snapshot, "1.11.2", "cloud-api-request", [{ path, method, body }]);
  for (const path of [
    "/api/transcriptions/batch-create",
    "/api/transcriptions/create",
    "/api/snippets/batch-create",
    "/api/conversations/messages",
    "/api/analytics/events/batch",
    "/api/activation/device",
    "/api/activation/batch",
    "/api/product-events/batch",
    "/api/product-events/app-session",
    "/api/v1/dictionary/create",
  ])
    assert.equal(allowed(path, "POST", {}), false, path);
  assert.equal(allowed("/api/dictionary/update", "PATCH", {}), false);
  assert.equal(allowed("/api/v1/snippets/snippet-id", "PATCH", {}), false);
  assert.equal(allowed("/api/notes/note/share", "PATCH", { visibility: "link" }), false);
  assert.equal(allowed("/api/notes/note/share", "PATCH", { visibility: "private" }), true);
  assert.equal(allowed("/api/notes/note/share/invitations", "POST", { emails: ["a@test"] }), false);
  assert.equal(allowed("/api/notes/note/access/grants", "POST", {}), false);
  assert.equal(
    allowed("/api/notes/note/access/grants/grant", "PATCH", { permission: "viewer" }),
    true
  );
  assert.equal(
    allowed("/api/notes/note/access/grants/grant", "PATCH", { permission: "editor" }),
    false
  );
  assert.equal(allowed("/api/notes/note/share", "DELETE"), true);
  assert.equal(allowed("/api/transcriptions/batch-delete", "POST", { ids: ["id"] }), true);
  assert.equal(allowed("/api/notes/delete", "DELETE", { id: "id" }), true);
  assert.equal(allowed("/api/shared-dictionary/create", "POST", { term: "team" }), true);
  assert.equal(allowed("/api/notes/create", "POST", { content: "share preparation" }), true);
  assert.equal(allowed("/api/folders/batch-create", "POST", { folders: [] }), true);
  assert.equal(allowed("/api/analytics/participation", "PATCH", { enabled: true }), false);
  assert.equal(allowed("/api/analytics/participation", "PATCH", { enabled: false }), true);
  assert.equal(allowed("/api/leaderboard/domain", "GET"), false);
  assert.equal(allowed("/api/workspaces/workspace/leaderboard", "GET"), false);
  assert.equal(allowed("/api/analytics/summary", "GET"), true);
  assert.equal(allowed("/api/analytics/participation", "GET"), true);
  assert.equal(allowed("/api/leaderboard/access", "GET"), true);
  assert.equal(allowed("/api/conversations/search", "POST", { query: "read" }), true);
  policy.sharing.externalLinkSharing = "domain_only";
  assert.equal(allowed("/api/notes/note/share", "PATCH", { visibility: "domain" }), true);
  assert.equal(allowed("/api/notes/note/share", "PATCH", { visibility: "link" }), false);
});

test("calendar connections and refreshes respect the connector setting", () => {
  const policy = defaultDevicePolicy();
  policy.features.agentEnabled = false;
  const snapshot = { success: true, managed: true, policy };
  assert.equal(productOperationAllowed(snapshot, "1.11.2", "gcal-start-oauth"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.2", "mcal-start-oauth"), true);
  policy.features.connectorsEnabled = false;
  for (const channel of [
    "gcal-start-oauth",
    "mcal-start-oauth",
    "gcal-sync-events",
    "mcal-sync-events",
  ])
    assert.equal(productOperationAllowed(snapshot, "1.11.2", channel), false, channel);
});

test("main execution rejects cloud and BYOK inference while permitting independently allowed web search", () => {
  const policy = defaultDevicePolicy();
  policy.transcription.allowedModes = ["local"];
  policy.llm.allowedModes = ["local"];
  const snapshot = { success: true, managed: true, policy };
  for (const [channel, args] of [
    ["cloud-transcribe"],
    ["cloud-reason"],
    ["dictation-realtime-start", [{ mode: "byok", provider: "openai-realtime" }]],
    ["assemblyai-streaming-warmup", [{ mode: "byok" }]],
    ["corti-streaming-start", [{}]],
    ["process-anthropic-reasoning"],
    ["enterprise-stream-start", [{ provider: "bedrock" }]],
  ])
    assert.equal(productOperationAllowed(snapshot, "1.11.1", channel, args), false, channel);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "transcribe-local-whisper"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "process-local-reasoning"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "agent-web-search"), true);
  policy.features.webSearchEnabled = false;
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "agent-web-search"), false);
});

test("direct operations enforce provider allowlists and the minimum app version", () => {
  const policy = defaultDevicePolicy();
  policy.transcription.allowedByokProviders = ["deepgram"];
  const snapshot = { success: true, managed: true, policy };
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "deepgram-streaming-start", [{ mode: "byok" }]),
    true
  );
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "assemblyai-streaming-start", [{ mode: "byok" }]),
    false
  );
  policy.minAppVersion = "1.12.0";
  for (const channel of ["process-local-reasoning", "cloud-transcribe"])
    assert.equal(productOperationAllowed(snapshot, "1.11.1", channel), false);
  assert.equal(
    productOperationAllowed({ success: false }, "1.11.1", "process-local-reasoning"),
    false
  );
});

test("agent-only revocation gates IPC agent work without disabling ordinary cleanup", () => {
  const policy = defaultDevicePolicy();
  policy.features.agentEnabled = false;
  const snapshot = { success: true, managed: true, policy };
  const channels = [
    ["cloud-reason", ["private", { requestPurpose: "agent" }]],
    ["cloud-api-request", [{ path: "/api/reason", body: { requestPurpose: "agent" } }]],
    ["process-local-reasoning", ["private", "model", null, { requiresAgent: true }]],
    ["process-anthropic-reasoning", ["private", "model", null, { requiresAgent: true }]],
    [
      "process-enterprise-reasoning",
      ["private", "model", null, { provider: "bedrock", requiresAgent: true }],
    ],
    ["enterprise-stream-start", [{ provider: "bedrock" }]],
  ];
  for (const [channel, args] of channels)
    assert.equal(productOperationAllowed(snapshot, "1.11.1", channel, args), false, channel);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "cloud-reason", ["private", {}]), true);
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "process-anthropic-reasoning", [
      "private",
      "model",
      null,
      {},
    ]),
    true
  );
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "process-enterprise-reasoning", [
      "private",
      "model",
      null,
      { provider: "bedrock" },
    ]),
    true
  );
});

test("known pending restrictions selectively revoke running work without admitting new remote work", () => {
  const { runningOperationAllowed } = require("../../src/helpers/productPolicy");
  const policy = defaultDevicePolicy();
  policy.llm.allowedModes = ["local"];
  const pending = {
    accountId: "member",
    success: false,
    status: "loading",
    deviceReady: true,
    managed: true,
    policy,
  };
  const allowed = (snapshot, accountId, channel) =>
    runningOperationAllowed(snapshot, accountId, "1.11.2", channel);
  assert.equal(allowed(pending, "member", "cloud-reason"), false);
  assert.equal(allowed(pending, "member", "process-local-reasoning"), true);
  assert.equal(allowed(pending, "member", "cloud-transcribe"), true);
  assert.equal(allowed({ ...pending, policy: null }, "member", "cloud-reason"), true);
  assert.equal(allowed(pending, "other-member", "process-local-reasoning"), false);
  assert.equal(productOperationAllowed(pending, "1.11.2", "cloud-transcribe"), false);
});
