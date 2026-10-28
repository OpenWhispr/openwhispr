const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createEnterpriseAudioRuntime } = require("./enterpriseAudioRuntime");
const { parseProxyCredential, requiresEnterpriseTransport } = require("./enterpriseAudioTransport");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");

function configFingerprint(provider, config) {
  const stable = (value) =>
    Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.entries(value)
            // Code-unit order, as the API sorts: localeCompare varies by locale (cs, sk).
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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

// Probe failures, each a device-check code the API accepts or a local code
// that REPORTED_AS folds into one.
const CHECK_MESSAGE_KEYS = {
  AUTH_REJECTED: "enterprise.audio.checks.authRejected",
  TLS_FAILED: "enterprise.audio.checks.tlsFailed",
  PROXY_FAILED: "enterprise.audio.checks.proxyFailed",
  TIMEOUT: "enterprise.audio.checks.timeout",
  CREDENTIAL_MISSING: "enterprise.audio.checks.credentialMissing",
  CONFIG_CHANGED: "enterprise.audio.checks.configChanged",
  PROTOCOL_FAILED: "enterprise.audio.checks.protocolFailed",
  NETWORK_FAILED: "enterprise.audio.checks.networkFailed",
  SECURE_STORAGE_UNAVAILABLE: "enterprise.audio.checks.secureStorageUnavailable",
  CA_UNAVAILABLE: "enterprise.audio.certificateUnavailable",
};
const REPORTED_AS = {
  SECURE_STORAGE_UNAVAILABLE: "CREDENTIAL_MISSING",
  CA_UNAVAILABLE: "TLS_FAILED",
};
// Failures that say nothing about this device's connection: the OpenWhispr
// API's own refusals and this app's policy or setup refusals. They are never
// reported as a device check, so they can't overwrite the last real result.
const SETUP_MESSAGE_KEYS = {
  CONFIG_CHANGED: "enterprise.audio.checks.configChanged",
  SSO_REQUIRED: "enterprise.audio.errors.ssoRequired",
  ENTERPRISE_REQUIRED: "enterprise.audio.errors.enterpriseRequired",
  SIGN_IN_REQUIRED: "enterprise.audio.errors.signInRequired",
  ACCESS_DENIED: "enterprise.audio.errors.accessDenied",
  RATE_LIMITED: "enterprise.audio.errors.rateLimited",
  POLICY_UNRESOLVABLE: "common.policyUnresolved",
  PROVIDER_POLICY_CONFLICT: "common.managedPolicyConflict",
  MANAGED_OPERATION_UNAVAILABLE: "enterprise.audio.operationUnavailable",
  MANAGED_CONFIG_AMBIGUOUS: "common.managedConfigAmbiguous",
};
const LOCAL_CODES = new Set([
  "SECURE_STORAGE_UNAVAILABLE",
  "BOOTSTRAP_NOT_PROTECTED",
  "BOOTSTRAP_UNREADABLE",
  "BOOTSTRAP_MISMATCH",
  "POLICY_UNRESOLVABLE",
  "PROVIDER_POLICY_CONFLICT",
  "MANAGED_OPERATION_UNAVAILABLE",
  "MANAGED_CONFIG_AMBIGUOUS",
]);

// OpenWhispr API errors carry their HTTP status; provider and network errors never do.
function apiRefusalCode(error) {
  if (!Number.isInteger(error?.status)) return null;
  if (["SSO_REQUIRED", "ENTERPRISE_REQUIRED"].includes(error.code)) return error.code;
  if (error.status === 409 || error.code === "MANAGED_CONFIG_CHANGED") return "CONFIG_CHANGED";
  if (error.status === 429) return "RATE_LIMITED";
  if (error.status === 401) return "SIGN_IN_REQUIRED";
  if (error.status === 403 || error.status === 404) return "ACCESS_DENIED";
  return "API_UNAVAILABLE";
}

function safeCheckCode(error) {
  const refusal = apiRefusalCode(error);
  if (refusal) return refusal;
  if (LOCAL_CODES.has(error?.code)) return error.code;
  if (error?.code === "PROTOCOL_FAILED") return "PROTOCOL_FAILED";
  if (error?.code === "CREDENTIAL_MISSING") return "CREDENTIAL_MISSING";
  if (error?.code === "MANAGED_CA_UNAVAILABLE") return "CA_UNAVAILABLE";
  if (["MANAGED_CONFIG_CHANGED", "AUTH_CONTEXT_CHANGED"].includes(error?.code))
    return "CONFIG_CHANGED";
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(error?.code ?? "")) return "TLS_FAILED";
  if (/PROXY/.test(error?.code ?? "") || /407/.test(error?.message ?? "")) return "PROXY_FAILED";
  if (
    ["TIMEOUT", "ABORT_ERR"].includes(error?.code) ||
    ["TimeoutError", "AbortError"].includes(error?.name)
  )
    return "TIMEOUT";
  // IDENTITY_EXCHANGE_FAILED without a status is Microsoft Entra refusing the token.
  if (
    ["MANAGED_AUTH_REJECTED", "IDENTITY_EXCHANGE_FAILED"].includes(error?.code) ||
    /401|403/.test(error?.message ?? "")
  )
    return "AUTH_REJECTED";
  return "NETWORK_FAILED";
}

function setupFailure(error) {
  const code = safeCheckCode(error);
  return {
    success: false,
    code,
    messageKey: error?.messageKey ?? SETUP_MESSAGE_KEYS[code] ?? "enterprise.audio.setupFailed",
  };
}

const ENTERPRISE_AUDIO_DEVICE_ID_FILE = "enterprise-audio-device-id";

// A random per-install id, so device checks never carry anything derived from the machine.
async function installDeviceId(file) {
  const stored = await fs.readFile(file, "utf8").catch(() => "");
  if (/^[a-f0-9]{32}$/.test(stored)) return stored;
  const id = randomBytes(16).toString("hex");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, id, { mode: 0o600 });
  return id;
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
  systemFetch,
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
  // Rejected at provisioning so a malformed proxy secret never reaches a request.
  const assertProxyCredentials = (config, entries) => {
    const slot = config.network?.proxy?.credentialSlot;
    if (slot && Object.hasOwn(entries, slot)) parseProxyCredential(entries[slot]);
  };
  const handle = (name, fn) =>
    ipcMain.handle(name, async (event, input = {}) => {
      try {
        return { success: true, ...(await fn(event, input)) };
      } catch (error) {
        return setupFailure(error);
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
      credentials: {
        saveMany: async (accountId, workspaceId, entries) => {
          assertProxyCredentials(record.config, entries);
          return credentials.saveMany(accountId, workspaceId, entries);
        },
      },
    });
  });
  handle(
    "enterprise-audio-save-credential",
    async (event, { provider, slot, secret, remove, context }) => {
      const { record, request } = await stored(event, provider, mutationContext(context));
      if (!slotsFor(record.config).includes(slot))
        throw new Error("This slot is not configured by the organization");
      if (remove) await credentials.remove(request.accountId, request.workspaceId, slot);
      else {
        assertProxyCredentials(record.config, { [slot]: secret });
        await credentials.save(request.accountId, request.workspaceId, slot, secret);
      }
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
      let failure;
      try {
        if (record.mode !== "disabled") profile = await runtime.resolve(request, operation);
        else {
          const draftRuntime = createEnterpriseAudioRuntime({
            credentials,
            transport,
            systemFetch,
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
                  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(current.record.config.tenantId)}/oauth2/v2.0/token`;
                  const tokenRequest = {
                    method: "POST",
                    body,
                    signal: AbortSignal.timeout(15000),
                  };
                  // Same stack the managed token exchange picks for this network profile.
                  const response =
                    systemFetch && !requiresEnterpriseTransport(network)
                      ? await systemFetch(tokenUrl, tokenRequest)
                      : await transport.request(tokenUrl, {
                          ...tokenRequest,
                          network,
                          caPem,
                          readCredential: (slot) =>
                            credentials.read(request.accountId, request.workspaceId, slot),
                        });
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
          throw Object.assign(new Error("The audio operation is not configured"), {
            code: "MANAGED_OPERATION_UNAVAILABLE",
            messageKey: "enterprise.audio.operationUnavailable",
          });
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
        // Only a code the API accepts as a device check is reported.
        if (apiRefusalCode(error) || !Object.hasOwn(CHECK_MESSAGE_KEYS, code)) throw error;
        failure = error;
      }
      await stored(event, provider, expected);
      await fetchApi(request, `${prefix}/device-checks`, {
        method: "POST",
        body: {
          configFingerprint: context.configFingerprint,
          operation,
          deviceId: await installDeviceId(
            path.join(bootstrapDirectory, ENTERPRISE_AUDIO_DEVICE_ID_FILE)
          ),
          appVersion: getVersion(),
          os: process.platform,
          status: code === "OK" ? "passed" : "failed",
          code: REPORTED_AS[code] ?? code,
        },
      });
      return {
        passed: code === "OK",
        code,
        operation,
        messageKey:
          code === "OK"
            ? "enterprise.audio.testPassed"
            : code === "NETWORK_FAILED"
              ? (failure.messageKey ?? CHECK_MESSAGE_KEYS.NETWORK_FAILED)
              : CHECK_MESSAGE_KEYS[code],
      };
    }
  );
}

module.exports = {
  ENTERPRISE_AUDIO_DEVICE_ID_FILE,
  registerEnterpriseAudioSetup,
  configFingerprint,
  safeCheckCode,
  silenceWav,
};
