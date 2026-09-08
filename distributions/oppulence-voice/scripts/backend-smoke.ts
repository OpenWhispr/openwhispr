import crypto from "node:crypto";
import { z } from "zod";

const RuntimeSchema = z.object({
  API_URL: z.string().url().default("http://127.0.0.1:28080"),
});
const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().positive(),
});
const LoginSchema = z.object({ url: z.string().url() });
const KeySchema = z.object({
  data: z.object({ id: z.string().uuid(), key: z.string().startsWith("opv_live_") }),
});
const VerifierSchema = z.object({
  data: z.object({
    verifiers: z.array(z.object({ id: z.string().uuid(), digest: z.string().length(64) })),
  }),
});
const SyncSchema = z.object({
  data: z.object({
    item_id: z.string(),
    operation: z.enum(["upsert", "delete"]),
    revision: z.number(),
  }),
});
const SyncListSchema = z.object({
  data: z.array(z.object({ item_id: z.string(), ciphertext: z.string(), revision: z.number() })),
});
const CaptureSchema = z.object({
  data: z.object({
    event_id: z.string().length(64),
    status: z.enum(["accepted", "deleted"]),
    duplicate: z.boolean(),
  }),
});

const { API_URL } = RuntimeSchema.parse(process.env);

async function waitForAPI(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/readyz`);
      if (response.ok) return;
    } catch {
      // The release image may still be applying migrations.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Rowboat API did not become ready at ${API_URL}`);
}

async function jsonRequest<T>(
  schema: z.ZodType<T>,
  pathname: string,
  init: RequestInit = {},
  expectedStatus = 200
): Promise<T> {
  const response = await fetch(`${API_URL}${pathname}`, init);
  const body: unknown = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} returned ${response.status}: ${JSON.stringify(body)}`
    );
  }
  return schema.parse(body);
}

async function authenticate(): Promise<string> {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const callback = "http://127.0.0.1:18091/callback";
  const query = new URLSearchParams({
    redirect_uri: callback,
    state,
    code_challenge: challenge,
    provider: "authkit",
  });
  const login = await jsonRequest(LoginSchema, `/v1/auth/workos/login-url?${query}`);
  const authorize = await fetch(login.url, { redirect: "manual" });
  const location = authorize.headers.get("location");
  if (!location) throw new Error("Mock AuthKit did not return a callback redirect");
  const redirected = new URL(location);
  if (redirected.searchParams.get("state") !== state) throw new Error("AuthKit state mismatch");
  const code = redirected.searchParams.get("code");
  if (!code) throw new Error("Mock AuthKit did not return an authorization code");
  const token = await jsonRequest(TokenSchema, "/v1/auth/workos/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  return token.access_token;
}

function authorized(token: string, extra: Record<string, string> = {}): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  await waitForAPI();
  const token = await authenticate();
  const key = await jsonRequest(
    KeySchema,
    "/api/v1/keys/create",
    {
      method: "POST",
      headers: authorized(token),
      body: JSON.stringify({ name: "Local E2E smoke", scopes: ["notes:read", "notes:write"] }),
    },
    201
  );
  const verifiers = await jsonRequest(VerifierSchema, "/v1/voice/api-key-verifiers", {
    headers: authorized(token),
  });
  if (!verifiers.data.verifiers.some((verifier) => verifier.id === key.data.id)) {
    throw new Error("Created API key was absent from the verifier snapshot");
  }

  const suffix = crypto.randomBytes(8).toString("hex");
  const itemID = `smoke-${suffix}`;
  const occurredAt = new Date().toISOString();
  const syncBase = {
    schema_version: "1.0",
    collection: "note",
    item_id: itemID,
    key_id: "local-smoke-v1",
    nonce: Buffer.from("local-smoke-nonce").toString("base64url"),
    occurred_at: occurredAt,
  };
  const created = await jsonRequest(
    SyncSchema,
    "/v1/voice-sync/items",
    {
      method: "POST",
      headers: authorized(token),
      body: JSON.stringify({
        ...syncBase,
        operation: "upsert",
        ciphertext: Buffer.from("encrypted-local-smoke").toString("base64url"),
        content_hash: sha256("encrypted-local-smoke"),
      }),
    },
    201
  );
  if (created.data.revision !== 1) throw new Error("Initial sync revision was not one");
  const listed = await jsonRequest(
    SyncListSchema,
    "/v1/voice-sync/items?collection=note&limit=500",
    { headers: authorized(token) }
  );
  if (!listed.data.some((item) => item.item_id === itemID)) {
    throw new Error("Created sync item was not listed");
  }
  await jsonRequest(SyncSchema, "/v1/voice-sync/items", {
    method: "POST",
    headers: authorized(token),
    body: JSON.stringify({
      ...syncBase,
      operation: "delete",
      base_revision: 1,
      ciphertext: Buffer.from("encrypted-tombstone").toString("base64url"),
      content_hash: sha256("encrypted-tombstone"),
    }),
  });

  const content = JSON.stringify({ title: "Local smoke", content: "Oppulence Voice E2E" });
  const eventID = sha256(`capture:${suffix}`);
  const envelope = {
    schemaVersion: "1.0",
    eventId: eventID,
    artifactId: `oppulence-voice:note:${itemID}`,
    kind: "note",
    operation: "upsert",
    occurredAt,
    source: {
      application: "Oppulence Voice",
      distributionId: "oppulence-voice",
      localId: itemID,
      event: "smoke",
    },
    consent: { basis: "user_opt_in", destination: "rowboat" },
    contentHash: sha256(content),
    content: JSON.parse(content) as unknown,
  };
  const captureHeaders = authorized(token, { "idempotency-key": eventID });
  await jsonRequest(
    CaptureSchema,
    "/v1/capture-artifacts",
    { method: "POST", headers: captureHeaders, body: JSON.stringify(envelope) },
    202
  );
  const replay = await jsonRequest(CaptureSchema, "/v1/capture-artifacts", {
    method: "POST",
    headers: captureHeaders,
    body: JSON.stringify(envelope),
  });
  if (!replay.data.duplicate) throw new Error("Capture replay was not reported as a duplicate");
  await jsonRequest(CaptureSchema, `/v1/capture-artifacts/${eventID}`, {
    headers: authorized(token),
  });

  console.log(`Oppulence Voice backend smoke passed against ${API_URL}`);
}

// Not top-level await: tsx transforms this file as CJS, where that is a
// syntax error, so the smoke test could never actually run.
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
