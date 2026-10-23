const { createHash } = require("node:crypto");
const os = require("node:os");
const { createEnterpriseAudioRuntime } = require("./enterpriseAudioRuntime");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");

function configFingerprint(provider, config) {
  const stable = (value) =>
    Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
            .join(",")}}`
        : JSON.stringify(value);
  return createHash("sha256")
    .update(
      stable(
        provider === "azure" ? { ...config, endpoint: new URL(config.endpoint).origin } : config
      )
    )
    .digest("hex");
}

function safeCheckCode(error) {
  if (error?.code === "PROTOCOL_FAILED") return "PROTOCOL_FAILED";
  if (error?.code === "CREDENTIAL_MISSING") return "CREDENTIAL_MISSING";
  if (["MANAGED_CONFIG_CHANGED", "AUTH_CONTEXT_CHANGED"].includes(error?.code))
    return "CONFIG_CHANGED";
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(error?.code ?? "")) return "TLS_FAILED";
  if (/PROXY/.test(error?.code ?? "") || /407/.test(error?.message ?? "")) return "PROXY_FAILED";
  if (
    ["TIMEOUT", "ABORT_ERR"].includes(error?.code) ||
    ["TimeoutError", "AbortError"].includes(error?.name)
  )
    return "TIMEOUT";
  if (error?.code === "MANAGED_AUTH_REJECTED" || /401|403/.test(error?.message ?? ""))
    return "AUTH_REJECTED";
  return "NETWORK_FAILED";
}

function silenceWav() {
  const pcmBytes = 24000;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);
  return wav;
}

function registerEnterpriseAudioSetup({
  ipcMain,
  getRequest,
  fetchApi,
  credentials,
  runtime,
  transport,
  getVersion,
  bootstrapDirectory,
  getRetirementSignal,
}) {
  async function stored(event, provider, expected) {
    if (!["azure", "openai-compatible"].includes(provider))
      throw new Error("Invalid audio provider");
    if (
      !expected ||
      typeof expected.accountId !== "string" ||
      typeof expected.workspaceId !== "string" ||
      !Number.isSafeInteger(expected.authGeneration) ||
      !Number.isSafeInteger(expected.generation) ||
      !Number.isSafeInteger(expected.providerVersion)
    )
      throw Object.assign(new Error("Enterprise audio setup context is required"), {
        code: "AUTH_CONTEXT_CHANGED",
      });
    const request = await getRequest(event, expected);
    const prefix = `/api/workspaces/${encodeURIComponent(request.workspaceId)}/enterprise-providers/${provider}`;
    const record = await fetchApi(request, prefix);
    const context =
      record.mode === "disabled"
        ? await fetchApi(request, `${prefix}/test-context`)
        : { record, configFingerprint: configFingerprint(provider, record.config) };
    await getRequest(event, expected);
    if (
      context.record.version !== expected.providerVersion ||
      (expected.configFingerprint && expected.configFingerprint !== context.configFingerprint)
    )
      throw Object.assign(new Error("Enterprise audio setup configuration changed"), {
        code: "MANAGED_CONFIG_CHANGED",
      });
    return { ...context, request, prefix };
  }
  const slotsFor = (config) => [
    ...new Set(
      [
        config.batch?.authentication?.credentialSlot,
        config.realtime?.authentication?.credentialSlot,
        config.network?.proxy?.credentialSlot,
      ].filter(Boolean)
    ),
  ];
  const handle = (name, fn) =>
    ipcMain.handle(name, async (event, input = {}) => {
      try {
        return { success: true, ...(await fn(event, input)) };
      } catch (error) {
        return {
          success: false,
          code: safeCheckCode(error),
          messageKey: "enterprise.audio.setupFailed",
        };
      }
    });
  handle("enterprise-audio-status", async (event, { provider, context: expected }) => {
    const context = await stored(event, provider, expected);
    const { request, record } = context;
    const slots = await Promise.all(
      slotsFor(record.config).map(async (slot) => ({
        slot,
        ...(await credentials.status(request.accountId, request.workspaceId, slot)),
      }))
    );
    return {
      slots,
      mode: record.mode,
      operations: [
        ...(record.config.batch || record.config.transcription ? ["batch"] : []),
        ...(record.config.realtime ? ["realtime"] : []),
      ],
      configFingerprint: context.configFingerprint,
    };
  });
  const mutationContext = (context) => {
    if (!/^[a-f0-9]{64}$/.test(context?.configFingerprint ?? ""))
      throw Object.assign(new Error("Refresh enterprise audio setup before continuing"), {
        code: "MANAGED_CONFIG_CHANGED",
      });
    return context;
  };
  handle("enterprise-audio-import-bootstrap", async (event, { provider, context }) => {
    const { record, request } = await stored(event, provider, mutationContext(context));
    return require("./enterpriseAudioBootstrap").importEnterpriseAudioBootstrap({
      directory: bootstrapDirectory,
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      allowedSlots: slotsFor(record.config),
      credentials,
    });
  });
  handle(
    "enterprise-audio-save-credential",
    async (event, { provider, slot, secret, remove, context }) => {
      const { record, request } = await stored(event, provider, mutationContext(context));
      if (!slotsFor(record.config).includes(slot))
        throw new Error("This slot is not configured by the organization");
      if (remove) await credentials.remove(request.accountId, request.workspaceId, slot);
      else await credentials.save(request.accountId, request.workspaceId, slot, secret);
      return { present: !remove };
    }
  );
  handle(
    "enterprise-audio-test",
    async (event, { provider, operation, allowInferenceValidation, context: expected }) => {
      if (allowInferenceValidation !== true)
        throw new Error("Acknowledge the bounded audio test requests before testing");
      if (!["batch", "realtime"].includes(operation)) throw new Error("Invalid audio operation");
      const context = await stored(event, provider, mutationContext(expected));
      const { request, record, prefix } = context;
      let profile;
      let code = "OK";
      try {
        if (record.mode !== "disabled") profile = await runtime.resolve(request, operation);
        else {
          const draftRuntime = createEnterpriseAudioRuntime({
            credentials,
            transport,
            getRetirementSignal,
            resolveProvider: async () => {
              const current = await stored(event, provider, expected);
              if (
                current.request.accountId !== request.accountId ||
                current.request.workspaceId !== request.workspaceId ||
                current.request.expectedAuthGeneration !== request.expectedAuthGeneration
              )
                throw Object.assign(new Error("Enterprise audio identity changed"), {
                  code: "AUTH_CONTEXT_CHANGED",
                });
              return {
                managed: true,
                provider,
                model: (operation === "batch"
                  ? current.record.config.batch
                  : current.record.config.realtime
                )?.defaultDeployment,
                config: current.record.config,
                version: current.record.version,
                generation: current.configFingerprint,
                identity: { accountId: request.accountId, workspaceId: request.workspaceId },
                certificateBundles: current.certificateBundles,
                tokenProvider: async () => {
                  const assertion = await fetchApi(request, `${prefix}/test-context`, {
                    method: "POST",
                    body: { configFingerprint: current.configFingerprint, operation },
                  });
                  const scope =
                    operation === "realtime"
                      ? (current.record.config.realtime?.tokenScope ??
                        (current.record.config.realtime?.protocol === "openai-transcription-ga"
                          ? "https://ai.azure.com/.default"
                          : "https://cognitiveservices.azure.com/.default"))
                      : "https://cognitiveservices.azure.com/.default";
                  const body = new URLSearchParams({
                    client_id: current.record.config.clientId,
                    grant_type: "client_credentials",
                    scope,
                    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                    client_assertion: assertion.assertion,
                  });
                  const network = current.record.config.network ?? {};
                  const caPem = current.certificateBundles?.find(
                    (bundle) => bundle.id === network.caBundleId
                  )?.pem;
                  const response = await transport.request(
                    `https://login.microsoftonline.com/${encodeURIComponent(current.record.config.tenantId)}/oauth2/v2.0/token`,
                    {
                      method: "POST",
                      body,
                      signal: AbortSignal.timeout(15000),
                      network,
                      caPem,
                      readCredential: (slot) =>
                        credentials.read(request.accountId, request.workspaceId, slot),
                    }
                  );
                  if (!response.ok)
                    throw new Error(`Enterprise identity exchange failed (${response.status})`);
                  const token = (await response.json()).access_token;
                  if (typeof token !== "string")
                    throw new Error("Enterprise identity response is invalid");
                  return token;
                },
              };
            },
          });
          profile = await draftRuntime.resolve(request, operation);
        }
        if (!profile || profile.provider !== provider)
          throw new Error("The audio operation is not configured");
        const signal = AbortSignal.timeout(30000);
        if (operation === "batch") {
          const form = new FormData();
          form.append(
            "file",
            new Blob([silenceWav()], { type: "audio/wav" }),
            "connection-test.wav"
          );
          form.append("model", profile.model);
          form.append("response_format", "json");
          const response = await profile.request({ method: "POST", body: form, signal });
          if (!response.ok) throw new Error(`Enterprise audio probe failed (${response.status})`);
          if (typeof (await response.json())?.text !== "string")
            throw Object.assign(new Error("Unsupported transcription response"), {
              code: "PROTOCOL_FAILED",
            });
        } else {
          const streaming = new OpenAIRealtimeStreaming();
          try {
            await streaming.connect({
              mode: "enterprise",
              model: profile.model,
              protocol: profile.protocol,
              createSocket: () => profile.createSocket(signal),
              inputRate: 24000,
              preconfigured: false,
            });
            streaming.sendAudio(Buffer.alloc(4800));
          } finally {
            await streaming.disconnect();
          }
        }
      } catch (error) {
        code = safeCheckCode(error);
      }
      await stored(event, provider, expected);
      await fetchApi(request, `${prefix}/device-checks`, {
        method: "POST",
        body: {
          configFingerprint: context.configFingerprint,
          operation,
          deviceId: createHash("sha256").update(os.hostname()).digest("hex").slice(0, 32),
          appVersion: getVersion(),
          os: process.platform,
          status: code === "OK" ? "passed" : "failed",
          code,
        },
      });
      return { passed: code === "OK", code, operation };
    }
  );
}

module.exports = { registerEnterpriseAudioSetup, configFingerprint, safeCheckCode, silenceWav };
