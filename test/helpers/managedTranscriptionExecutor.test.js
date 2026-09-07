const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createManagedTranscriptionExecutor,
} = require("../../src/helpers/managedTranscriptionExecutor.js");

const context = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 1,
  setupMode: "auto",
  inferenceScope: "transcription",
  provider: "azure",
  generation: 3,
  providerVersion: 2,
};
const route = {
  transport: "managed",
  provider: "azure",
  deployment: "renderer-guess",
  context,
  language: "de",
};

function runtime(apiVersion = "v1") {
  return {
    provider: "azure",
    model: "gpt-4o-transcribe",
    apiKey: "",
    enterprise: {
      azureEndpoint: "https://acme.services.ai.azure.com",
      azureApiVersion: apiVersion,
      managedTokenProvider: async () => "entra-token",
    },
  };
}

async function buildUrl(endpoint, deployment, apiVersion) {
  const { buildManagedAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");
  return buildManagedAzureTranscriptionUrl(endpoint, deployment, apiVersion);
}

function executor({ fetch, apiVersion, resolve } = {}) {
  return createManagedTranscriptionExecutor({
    resolveEnterpriseRuntime: resolve ?? (async () => runtime(apiVersion)),
    proxyFetch: fetch,
    buildUrl,
  });
}

const input = {
  audioBuffer: Buffer.from("audio"),
  fileName: "audio.webm",
  contentType: "audio/webm",
  prompt: "Möbius",
};

test("posts multipart audio to the workspace deployment with an Entra bearer", async () => {
  const calls = [];
  const run = executor({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ text: "hallo welt" }), { status: 200 });
    },
  });
  assert.equal(await run({}, route, input), "hallo welt");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://acme.services.ai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview"
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer entra-token");
  const body = calls[0].init.body;
  assert.equal(body.get("model"), "gpt-4o-transcribe"); // workspace default, not the renderer's value
  assert.equal(body.get("response_format"), "json");
  assert.equal(body.get("language"), "de");
  assert.equal(body.get("prompt"), "Möbius");
  assert.equal(body.get("file").name, "audio.webm");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("maps Azure failures to coded errors", async () => {
  for (const [status, code] of [
    [429, "PROVIDER_RATE_LIMITED"],
    [503, "SERVER_ERROR"],
    [401, "MANAGED_AUTH_REJECTED"],
  ]) {
    const run = executor({ fetch: async () => new Response("nope", { status }) });
    await assert.rejects(run({}, route, input), (error) => error.code === code, String(status));
  }
});

test("rejects routes that are not a managed transcription route", async () => {
  const run = executor({ fetch: async () => new Response("{}", { status: 200 }) });
  await assert.rejects(
    run({}, { ...route, context: { ...context, inferenceScope: "dictationCleanup" } }, input),
    (error) => error.code === "MANAGED_ROUTE_INVALID"
  );
});

test("propagates MANAGED_CONFIG_CHANGED from runtime revalidation", async () => {
  const run = executor({
    fetch: async () => new Response("{}", { status: 200 }),
    resolve: async () => {
      throw Object.assign(new Error("changed"), { code: "MANAGED_CONFIG_CHANGED" });
    },
  });
  await assert.rejects(run({}, route, input), (error) => error.code === "MANAGED_CONFIG_CHANGED");
});

test("an empty transcript is reported as no speech", async () => {
  const run = executor({
    fetch: async () => new Response(JSON.stringify({ text: "  " }), { status: 200 }),
  });
  await assert.rejects(run({}, route, input), (error) => error.code === "NO_SPEECH_DETECTED");
});
