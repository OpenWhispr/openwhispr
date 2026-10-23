const { runAbortableOperation } = require("./enterpriseProviderErrors");

const createEnterpriseAudioConfigChangedError = () =>
  Object.assign(new Error("Enterprise audio configuration changed"), {
    code: "MANAGED_CONFIG_CHANGED",
    messageKey: "common.managedConfigUnavailable",
  });

function createEnterpriseAudioRequestResolver({
  getIdentity,
  getBinding,
  setBinding,
  getAuthHeaders,
  getWorkspaces,
  getConfig,
  getScopeRevision = () => 0,
}) {
  return async (event, context, resolveMissing = false) => {
    const identity = getIdentity();
    const scopeRevision = getScopeRevision();
    const authChanged = () =>
      Object.assign(new Error("Enterprise audio identity changed"), {
        code: "AUTH_CONTEXT_CHANGED",
        messageKey: "common.managedConfigUnavailable",
      });
    const assertIdentity = () => {
      const current = getIdentity();
      if (
        current.accountId !== identity.accountId ||
        current.authGeneration !== identity.authGeneration ||
        current.signedIn !== identity.signedIn ||
        getScopeRevision() !== scopeRevision
      )
        throw authChanged();
    };
    if (!identity.signedIn && !context && resolveMissing) return null;
    if (
      !identity.accountId ||
      (context &&
        (context.accountId !== identity.accountId ||
          context.authGeneration !== identity.authGeneration))
    )
      throw authChanged();
    const authHeaders = await getAuthHeaders(event);
    assertIdentity();
    let binding = getBinding();
    if (!binding && resolveMissing) {
      const workspaces = await getWorkspaces(authHeaders);
      assertIdentity();
      if (!context?.workspaceId && workspaces.length === 0) return null;
      if (!workspaces.some((workspace) => workspace.id === context?.workspaceId))
        throw authChanged();
      const snapshot = await getConfig({
        accountId: identity.accountId,
        workspaceId: context.workspaceId,
        expectedAuthGeneration: identity.authGeneration,
        authHeaders,
      });
      assertIdentity();
      if (!snapshot.success || !snapshot.config) throw createEnterpriseAudioConfigChangedError();
      binding = { ...snapshot, generation: snapshot.config.generation };
      setBinding(binding);
    }
    if (
      !binding ||
      binding.accountId !== identity.accountId ||
      binding.authGeneration !== identity.authGeneration ||
      (context &&
        (context.workspaceId !== binding.workspaceId ||
          (context.generation !== undefined && context.generation !== binding.generation)))
    )
      throw authChanged();
    return {
      accountId: binding.accountId,
      workspaceId: binding.workspaceId,
      expectedAuthGeneration: binding.authGeneration,
      authHeaders,
      setupMode: context?.setupMode ?? "auto",
    };
  };
}

function createEnterpriseAudioRuntime({
  resolveProvider,
  transport,
  credentials,
  getRetirementSignal = () => null,
}) {
  async function resolve(request, operation = "batch") {
    const resolved = await resolveProvider({
      ...request,
      inferenceScope: "transcription",
      operation,
    });
    if (!resolved.managed) return null;
    const retirement = getRetirementSignal();
    const credentialGeneration = credentials.generation;
    const { config, provider } = resolved;
    const section =
      operation === "realtime"
        ? config.realtime
        : provider === "azure"
          ? config.transcription
          : config.batch;
    if (!section)
      throw Object.assign(new Error("Enterprise audio operation is unavailable"), {
        code: "MANAGED_OPERATION_UNAVAILABLE",
        messageKey: "enterprise.audio.operationUnavailable",
      });
    const network = config.network ?? {};
    const bundle = network.caBundleId
      ? resolved.certificateBundles?.find((entry) => entry.id === network.caBundleId)
      : null;
    if (network.caBundleId && !bundle)
      throw Object.assign(new Error("Enterprise certificate bundle is unavailable"), {
        code: "MANAGED_CA_UNAVAILABLE",
        messageKey: "enterprise.audio.certificateUnavailable",
      });
    let endpoint = section.endpoint;
    if (provider === "azure") {
      if (operation === "batch") {
        const { buildManagedAzureTranscriptionUrl } = await import("../utils/urlUtils.ts");
        endpoint = buildManagedAzureTranscriptionUrl(
          config.endpoint,
          section.defaultDeployment,
          config.apiVersion
        );
      } else {
        const url = new URL(config.endpoint);
        url.protocol = "wss:";
        url.pathname =
          section.protocol === "openai-transcription-ga"
            ? "/openai/v1/realtime"
            : "/openai/realtime";
        url.searchParams.set("intent", "transcription");
        if (section.protocol !== "openai-transcription-ga")
          url.searchParams.set("api-version", section.apiVersion);
        endpoint = url.href;
      }
    }
    if (!endpoint) throw new Error("Enterprise audio endpoint is unavailable");
    async function assertCurrent() {
      retirement?.throwIfAborted();
      if (credentials.generation !== credentialGeneration)
        throw createEnterpriseAudioConfigChangedError();
      const current = await resolveProvider({
        ...request,
        inferenceScope: "transcription",
        operation,
      });
      retirement?.throwIfAborted();
      if (
        credentials.generation !== credentialGeneration ||
        !current.managed ||
        current.provider !== provider ||
        current.generation !== resolved.generation ||
        current.version !== resolved.version
      )
        throw createEnterpriseAudioConfigChangedError();
      return current;
    }
    const readCredential = (slot) =>
      credentials.read(resolved.identity.accountId, resolved.identity.workspaceId, slot);
    async function headers() {
      const current = await assertCurrent();
      const secret =
        provider === "azure"
          ? await current.tokenProvider()
          : await credentials.read(
              current.identity.accountId,
              current.identity.workspaceId,
              section.authentication.credentialSlot
            );
      await assertCurrent();
      if (credentials.generation !== credentialGeneration)
        throw createEnterpriseAudioConfigChangedError();
      return provider === "azure" || section.authentication.type === "bearer"
        ? { Authorization: `Bearer ${secret}` }
        : { "api-key": secret };
    }
    return {
      provider,
      operation,
      endpoint,
      model: section.defaultDeployment,
      network,
      section,
      generation: resolved.generation,
      providerVersion: resolved.version,
      credentialGeneration,
      signal: retirement,
      protocol: section.protocol,
      async request(init) {
        const signal = AbortSignal.any([retirement, init.signal].filter(Boolean));
        const auth = await runAbortableOperation(headers, signal);
        const response = await runAbortableOperation(
          () =>
            transport.request(endpoint, {
              ...init,
              signal,
              headers: { ...init.headers, ...auth },
              network,
              readCredential,
              caPem: bundle?.pem,
            }),
          signal
        );
        await runAbortableOperation(assertCurrent, signal);
        return response;
      },
      async createSocket(signal) {
        signal = AbortSignal.any([retirement, signal].filter(Boolean));
        return transport.createSocket(endpoint, {
          headers: await runAbortableOperation(headers, signal),
          network,
          readCredential,
          caPem: bundle?.pem,
          signal,
        });
      },
      assertCurrent,
    };
  }
  return { resolve };
}

module.exports = {
  createEnterpriseAudioRuntime,
  createEnterpriseAudioRequestResolver,
  createEnterpriseAudioConfigChangedError,
};
