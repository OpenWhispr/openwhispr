const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingStreamingProviders.js");

test("tinfoil-realtime resolves to the Tinfoil client, never the OpenAI default", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER } = await load();
  const { TinfoilRealtimeStreaming } =
    await import("../../src/helpers/tinfoilRealtimeStreaming.js");
  const OpenAIRealtimeStreaming = (await import("../../src/helpers/openaiRealtimeStreaming.js"))
    .default;

  assert.equal(STREAMING_CLIENT_BY_PROVIDER["tinfoil-realtime"], TinfoilRealtimeStreaming);
  assert.notEqual(STREAMING_CLIENT_BY_PROVIDER["tinfoil-realtime"], OpenAIRealtimeStreaming);
});

test("every allowed realtime provider has a streaming client (no silent OpenAI fallback)", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER, ALLOWED_MEETING_PROVIDERS } = await load();

  for (const provider of ALLOWED_MEETING_PROVIDERS) {
    if (provider === "local") continue;
    assert.equal(
      typeof STREAMING_CLIENT_BY_PROVIDER[provider],
      "function",
      `${provider} is allowed but would fall through to the OpenAI default class`
    );
  }
});

test("allow-list accepts tinfoil-realtime and local", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();

  assert.equal(ALLOWED_MEETING_PROVIDERS.has("tinfoil-realtime"), true);
  assert.equal(ALLOWED_MEETING_PROVIDERS.has("local"), true);
});

test("every provider note recording offers is one the main process accepts", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();
  const { MEETING_STREAMING_PROVIDER_IDS } =
    await import("../../src/helpers/meetingTranscriptionRouting.js");

  // Note recording derives its streaming provider id by concatenation
  // (`${provider.id}-realtime`), so an offered catalog id with no client class
  // is rejected at meeting-transcription-prepare with no user-visible message.
  for (const id of MEETING_STREAMING_PROVIDER_IDS) {
    assert.equal(
      ALLOWED_MEETING_PROVIDERS.has(`${id}-realtime`),
      true,
      `${id} is offered for note recording but ${id}-realtime has no streaming client`
    );
  }
});

test("a dictation-only streaming provider is not offered for note recording", async () => {
  const { getStreamingTranscriptionProviders, getMeetingStreamingTranscriptionProviders } =
    await import("../../src/models/ModelRegistry.ts");

  const streamingIds = getStreamingTranscriptionProviders().map((provider) => provider.id);
  const meetingIds = getMeetingStreamingTranscriptionProviders().map((provider) => provider.id);

  assert.ok(streamingIds.includes("gemini"), "gemini ships a streaming dictation model");
  assert.equal(meetingIds.includes("gemini"), false);
});

// The intersection is an allow-list, so a new streaming provider is silently
// excluded from note recording unless it is listed. Deepgram and AssemblyAI are
// the managed note-recording providers and must stay admitted.
test("deepgram and assemblyai are offered for note recording", async () => {
  const { getMeetingStreamingTranscriptionProviders } =
    await import("../../src/models/ModelRegistry.ts");

  const meetingIds = getMeetingStreamingTranscriptionProviders().map((provider) => provider.id);
  assert.ok(meetingIds.includes("deepgram"));
  assert.ok(meetingIds.includes("assemblyai"));
});

test("allow-list rejects unknown and batch-only providers", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();

  // The bare ids are live settings values now, so they must not be mistaken for
  // meeting provider ids (which always carry the "-realtime" suffix).
  for (const provider of [
    "tinfoil",
    "openai",
    "deepgram",
    "assemblyai",
    "mistral-realtime",
    "grok-stt",
    "",
    undefined,
  ]) {
    assert.equal(ALLOWED_MEETING_PROVIDERS.has(provider), false, `${provider} must be rejected`);
  }
});

test("client lookup fails closed instead of defaulting to OpenAI", async () => {
  const { getMeetingStreamingClient } = await load();

  assert.throws(() => getMeetingStreamingClient("unknown-realtime"), /Unsupported meeting/);
});

test("OpenAI-derived streaming clients carry their own provider log label", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER } = await load();
  const OpenAIRealtimeStreaming = (await import("../../src/helpers/openaiRealtimeStreaming.js"))
    .default;
  const baseLabel = new OpenAIRealtimeStreaming().providerLabel;

  assert.equal(typeof baseLabel, "string");
  assert.ok(baseLabel.length > 0, "the base class must define a provider log label");

  for (const [provider, StreamingClient] of Object.entries(STREAMING_CLIENT_BY_PROVIDER)) {
    if (StreamingClient === OpenAIRealtimeStreaming) continue;
    if (!(StreamingClient.prototype instanceof OpenAIRealtimeStreaming)) continue;
    assert.notEqual(
      new StreamingClient().providerLabel,
      baseLabel,
      `${provider} inherits the OpenAI log label and would misreport where audio goes`
    );
  }
});

test("connection identity includes every provider-specific option", async () => {
  const { getMeetingConnectionKey } = await load();
  const options = {
    provider: "corti-realtime",
    model: "corti-transcribe",
    language: "en",
    mode: "byok",
    environment: "us",
    tenant: "tenant-a",
    keyterms: ["OpenWhispr"],
  };

  assert.equal(getMeetingConnectionKey(options), getMeetingConnectionKey({ ...options }));
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, provider: "tinfoil-realtime" })
  );
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, tenant: "tenant-b" })
  );
});

test("connection identity follows key saves exactly when the token comes from a saved key", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER, getMeetingConnectionKey } = await load();
  const { fetchRealtimeTokenForProvider } =
    await import("../../src/helpers/realtimeTokenProviders.js");

  for (const provider of Object.keys(STREAMING_CLIENT_BY_PROVIDER)) {
    for (const mode of ["byok", "openwhispr"]) {
      let readsSavedKey = false;
      const savedKey = () => {
        readsSavedKey = true;
        return "key";
      };
      const options = { provider, mode, baseUrl: "https://stt.example.test/v1" };
      await fetchRealtimeTokenForProvider(
        provider,
        {
          environmentManager: new Proxy({}, { get: () => savedKey }),
          proxyFetch: async () => ({ ok: true, json: async () => ({ token: "token" }) }),
          postServerToken: async () => ({ token: "token", clientSecret: "token" }),
          mintCortiToken: async () => ({ token: savedKey() }),
          // stt-api reads the Titanium license, never a saved BYOK key.
          titaniumServiceKeyFor: () => "license",
        },
        options
      );
      assert.equal(
        getMeetingConnectionKey(options, 1) !== getMeetingConnectionKey(options, 2),
        readsSavedKey,
        `${provider} (${mode})`
      );
    }
  }
});

test("stt-api-realtime resolves to the stt-api client and is allowed for meetings", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER, ALLOWED_MEETING_PROVIDERS } = await load();
  const SttApiStreaming = require("../../src/helpers/sttApiStreaming.js");

  assert.equal(STREAMING_CLIENT_BY_PROVIDER["stt-api-realtime"], SttApiStreaming);
  assert.equal(ALLOWED_MEETING_PROVIDERS.has("stt-api-realtime"), true);
});

test("stt-api connection identity follows the endpoint and never embeds a credential", async () => {
  const { getMeetingConnectionKey } = await load();
  const options = {
    provider: "stt-api-realtime",
    mode: "self-hosted",
    baseUrl: "https://stt.example.test/v1",
  };

  assert.equal(getMeetingConnectionKey(options, 1), getMeetingConnectionKey(options, 2));
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, baseUrl: "https://other.example.test/v1" })
  );
});

test("stt-api connection key carries a non-reversible license fingerprint, never the key", async () => {
  const { getMeetingConnectionKey, licenseFingerprint } = await load();
  const options = {
    provider: "stt-api-realtime",
    mode: "self-hosted",
    baseUrl: "https://stt.example.test/v1",
  };
  const licenseA = "key/account-a.signature";
  const licenseB = "key/account-b.signature";

  const keyA = getMeetingConnectionKey(options, 1, licenseFingerprint(licenseA));
  const keyB = getMeetingConnectionKey(options, 1, licenseFingerprint(licenseB));
  const signedOut = getMeetingConnectionKey(options, 1, licenseFingerprint(null));

  assert.notEqual(keyA, keyB, "another account must not reuse a warm connection");
  assert.notEqual(keyA, signedOut, "signing out must not reuse a warm connection");
  assert.equal(keyA, getMeetingConnectionKey(options, 2, licenseFingerprint(licenseA)));
  assert.ok(!keyA.includes(licenseA));
  assert.match(licenseFingerprint(licenseA), /^[0-9a-f]{16}$/);
  assert.equal(licenseFingerprint(null), "");
  assert.equal(licenseFingerprint(""), "");
});

test("a stt-api connection is stale after sign-out or an account change, other providers never are", async () => {
  const { getMeetingConnectionKey, licenseFingerprint, isSttApiConnectionStale } = await load();
  const options = {
    provider: "stt-api-realtime",
    mode: "self-hosted",
    baseUrl: "https://stt.example.test/v1",
  };
  const openedUnder = getMeetingConnectionKey(options, null, licenseFingerprint("license-a"));
  const identityFor = (license) => (parsed) => {
    assert.equal(parsed.baseUrl, options.baseUrl);
    return licenseFingerprint(license);
  };

  assert.equal(isSttApiConnectionStale(openedUnder, identityFor("license-a")), false);
  assert.equal(isSttApiConnectionStale(openedUnder, identityFor(null)), true, "signed out");
  assert.equal(isSttApiConnectionStale(openedUnder, identityFor("license-b")), true, "account");

  const deepgram = getMeetingConnectionKey({ provider: "deepgram-realtime", mode: "byok" }, 1);
  assert.equal(
    isSttApiConnectionStale(deepgram, () => "anything"),
    false
  );
  assert.equal(
    isSttApiConnectionStale(null, () => ""),
    false
  );
  assert.equal(
    isSttApiConnectionStale("not json", () => ""),
    false
  );
});

test("a prepared stt-api key is recognised so a cancelled prepare can drop it", async () => {
  const { getMeetingConnectionKey, isSttApiConnectionKey } = await load();

  assert.equal(
    isSttApiConnectionKey(getMeetingConnectionKey({ provider: "stt-api-realtime" }, null, "x")),
    true
  );
  assert.equal(
    isSttApiConnectionKey(getMeetingConnectionKey({ provider: "deepgram-realtime" }, 1)),
    false
  );
  assert.equal(isSttApiConnectionKey(null), false);
});
