const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { ApiKeyVerifierSnapshotSchema } = require("../../src/config/openwhisprApi.ts");

/**
 * Contract tests between Oppulence Voice and the Oppulence API.
 *
 * These parse real API responses with the very schemas the desktop app uses at
 * runtime, so a server-side field rename fails here instead of silently
 * breaking key verification or note sync in a shipped build.
 *
 * They need a running API and are skipped otherwise, so the normal suite stays
 * hermetic. Point them at a stack with:
 *
 *   OPPULENCE_API_URL=http://localhost:18080 \
 *   OPPULENCE_API_TOKEN_URL="http://localhost:18090/mint?workos_user_id=user_dev_1&email=dev%40example.com" \
 *   npm test
 */
const API_URL = process.env.OPPULENCE_API_URL?.replace(/\/$/, "");
const TOKEN_URL = process.env.OPPULENCE_API_TOKEN_URL;

async function reachable() {
  if (!API_URL || !TOKEN_URL) return false;
  try {
    const response = await fetch(`${API_URL}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const SKIP_REASON =
  "set OPPULENCE_API_URL and OPPULENCE_API_TOKEN_URL to run the API contract tests";

// Checked inside each test rather than at module scope: a top-level await here
// would make this file an ES module, which the CommonJS test suite cannot
// require.
async function skipUnlessReachable(t) {
  if (await reachable()) return false;
  t.skip(SKIP_REASON);
  return true;
}

async function accessToken() {
  const response = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(5_000) });
  assert.ok(response.ok, `token endpoint returned ${response.status}`);
  const body = await response.json();
  const token = body.token || body.access_token || body.accessToken;
  assert.ok(token, "token endpoint returned no usable token");
  return token;
}

function authorized(token, extra = {}) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

test("the API key verifier snapshot parses with the app's schema", async (t) => {
  if (await skipUnlessReachable(t)) return;
  const token = await accessToken();

  const response = await fetch(`${API_URL}/v1/voice/api-key-verifiers`, {
    headers: authorized(token),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "verifier snapshot should be reachable");

  // apiKeyVerifier.ts parses the live response with exactly this schema and
  // throws on a mismatch, which would silently disable every API key.
  const snapshot = ApiKeyVerifierSnapshotSchema.parse(await response.json());
  assert.ok(
    Date.parse(snapshot.data.valid_until) > Date.now(),
    "snapshot must arrive with a future valid_until, or keys are rejected immediately"
  );
});

test("unauthenticated verifier requests are refused", async (t) => {
  if (await skipUnlessReachable(t)) return;
  const response = await fetch(`${API_URL}/v1/voice/api-key-verifiers`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 401, "the verifier snapshot must require a token");
});

test("a note round-trips through voice sync", async (t) => {
  if (await skipUnlessReachable(t)) return;
  const token = await accessToken();
  const itemId = `contract-${crypto.randomBytes(8).toString("hex")}`;
  const ciphertext = Buffer.from("contract-test-ciphertext").toString("base64url");
  const contentHash = crypto.createHash("sha256").update("contract-test-ciphertext").digest("hex");

  const created = await fetch(`${API_URL}/v1/voice-sync/items`, {
    method: "POST",
    headers: authorized(token),
    body: JSON.stringify({
      schema_version: "1.0",
      collection: "note",
      item_id: itemId,
      operation: "upsert",
      key_id: "contract-test-v1",
      nonce: Buffer.from("contract-nonce").toString("base64url"),
      occurred_at: new Date().toISOString(),
      ciphertext,
      content_hash: contentHash,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const createdBody = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  assert.equal(createdBody.data.revision, 1, "a new item starts at revision 1");

  const listed = await fetch(`${API_URL}/v1/voice-sync/items?collection=note&limit=500`, {
    headers: authorized(token),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(listed.status, 200);
  const items = (await listed.json()).data;
  const found = items.find((item) => item.item_id === itemId);
  assert.ok(found, "the item just written should come back in the list");

  // The server stores ciphertext verbatim: it never sees plaintext, and the
  // client could not decrypt a mutated payload.
  assert.equal(found.ciphertext, ciphertext, "ciphertext must round-trip untouched");
});

test("capture artifacts are idempotent on replay", async (t) => {
  if (await skipUnlessReachable(t)) return;
  const token = await accessToken();
  const suffix = crypto.randomBytes(8).toString("hex");
  const content = { title: "Contract test", content: "Oppulence Voice" };
  const serialized = JSON.stringify(content);
  const eventId = crypto.createHash("sha256").update(`capture:${suffix}`).digest("hex");
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    artifactId: `oppulence-voice:note:${suffix}`,
    kind: "note",
    operation: "upsert",
    occurredAt: new Date().toISOString(),
    source: {
      application: "Oppulence Voice",
      distributionId: "oppulence-voice",
      localId: suffix,
      event: "contract-test",
    },
    consent: { basis: "user_opt_in", destination: "rowboat" },
    contentHash: crypto.createHash("sha256").update(serialized).digest("hex"),
    content,
  };
  const headers = authorized(token, { "idempotency-key": eventId });

  const first = await fetch(`${API_URL}/v1/capture-artifacts`, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(10_000),
  });
  const firstBody = await first.json();
  assert.equal(first.status, 202, JSON.stringify(firstBody));
  assert.equal(firstBody.data.duplicate, false);

  // The outbox retries on any network wobble, so a replay must not create a
  // second copy of the same capture.
  const replay = await fetch(`${API_URL}/v1/capture-artifacts`, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    (await replay.json()).data.duplicate,
    true,
    "a replayed capture must be a duplicate"
  );
});
