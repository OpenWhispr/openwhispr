const crypto = require("crypto");
const fs = require("fs");
const {
  resolveManagedEnterpriseScope,
  validateManagedEnterpriseEnvelope,
} = require("./enterpriseManagedConfig.mjs");
const { AuthContextError } = require("./cloudApiRequest");

const CONFIG_CACHE_VERSION = 1;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const CREDENTIAL_REFRESH_WINDOW_MS = 60 * 1000;
const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default";

function normalizeId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAuthHeaders(value, token) {
  const headers = {};
  if (value && typeof value === "object") {
    if (typeof value.Authorization === "string" && value.Authorization) {
      headers.Authorization = value.Authorization;
    }
    if (typeof value.Cookie === "string" && value.Cookie) headers.Cookie = value.Cookie;
  }
  if (!headers.Authorization && !headers.Cookie && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function readCache(cachePath) {
  if (!fs.existsSync(cachePath)) return { version: CONFIG_CACHE_VERSION, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return parsed?.version === CONFIG_CACHE_VERSION && Array.isArray(parsed.entries)
      ? parsed
      : { version: CONFIG_CACHE_VERSION, entries: [] };
  } catch {
    return { version: CONFIG_CACHE_VERSION, entries: [] };
  }
}

function writeCache(cachePath, identity, config) {
  const envelope = readCache(cachePath);
  const entries = envelope.entries.filter((entry) => entry?.key !== identity.cacheKey);
  entries.push({ key: identity.cacheKey, workspaceId: identity.workspaceId, config });
  fs.writeFileSync(cachePath, JSON.stringify({ version: CONFIG_CACHE_VERSION, entries }), {
    mode: 0o600,
  });
}

function cachedConfig(cachePath, identity) {
  const entry = readCache(cachePath).entries.find(
    (candidate) => candidate?.key === identity.cacheKey
  );
  return validateManagedEnterpriseEnvelope(entry?.config, identity.workspaceId);
}

function removeCachedConfig(cachePath, identity) {
  const envelope = readCache(cachePath);
  const entries = envelope.entries.filter((entry) => entry?.key !== identity.cacheKey);
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ version: CONFIG_CACHE_VERSION, entries }), {
      mode: 0o600,
    });
  } catch {
    // A read-only cache must never prevent fail-closed in-memory eviction.
  }
}

function isTransientConfigError(error) {
  return (
    error?.name === "AbortError" ||
    (!Number.isFinite(error?.status) && error?.code !== "MANAGED_CONFIG_INVALID") ||
    error?.status >= 500
  );
}

function isAuthorizationError(error) {
  return (
    [401, 403, 404].includes(error?.status) ||
    [
      "AUTH_EXPIRED",
      "ENTERPRISE_REQUIRED",
      "SSO_REQUIRED",
      "DIRECTORY_ASSIGNMENT_REQUIRED",
      "PROVIDER_NOT_ALLOWED",
      "PROVIDER_NOT_CONFIGURED",
      "POLICY_UNRESOLVABLE",
    ].includes(error?.code)
  );
}

function requiresEnforcedManagedAccess(config) {
  return Boolean(
    config?.providers?.some(
      (record) =>
        record.mode !== "disabled" &&
        (record.mode === "managed_required" || !record.allowManualSetup)
    )
  );
}

function responseError(code, error, identity = null, enforcementRequired) {
  return {
    success: false,
    status: "error",
    accountId: identity?.accountId ?? null,
    workspaceId: identity?.workspaceId ?? null,
    authGeneration: identity?.authGeneration ?? null,
    code,
    error,
    ...(typeof enforcementRequired === "boolean" ? { enforcementRequired } : {}),
  };
}

function createEnterpriseIdentityManager({
  cachePath,
  getApiUrl,
  getAppVersion,
  proxyFetch,
  tokenStore,
  logger,
  broadcast,
  createAwsWebIdentityProvider = (init) =>
    require("@aws-sdk/credential-providers").fromWebToken(init),
  now = Date.now,
  requestTimeoutMs = 10_000,
}) {
  const configs = new Map();
  const configRequests = new Map();
  const cloudCredentials = new Map();
  const cloudCredentialRequests = new Map();
  let credentialEpoch = 0;

  function clearIdentityCredentials(identity) {
    credentialEpoch += 1;
    const prefix = `${identity.cacheKey}\n`;
    for (const key of cloudCredentials.keys()) {
      if (key.startsWith(prefix)) cloudCredentials.delete(key);
    }
    for (const key of cloudCredentialRequests.keys()) {
      if (key.startsWith(prefix)) cloudCredentialRequests.delete(key);
    }
  }

  function evictIdentity(identity, code, enforcementRequired = false) {
    configs.delete(identity.cacheKey);
    configRequests.delete(identity.cacheKey);
    clearIdentityCredentials(identity);
    removeCachedConfig(cachePath, identity);
    broadcast?.({
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      authGeneration: identity.authGeneration,
      config: null,
      code,
      enforcementRequired,
    });
  }

  function captureIdentity(request = {}) {
    const tokenState = tokenStore.getState();
    if (
      !Number.isSafeInteger(request.expectedAuthGeneration) ||
      request.expectedAuthGeneration < 0 ||
      request.expectedAuthGeneration !== tokenState.generation
    ) {
      throw new AuthContextError("Authentication changed before managed enterprise request");
    }
    const accountId = normalizeId(request.accountId);
    const workspaceId = normalizeId(request.workspaceId);
    if (!accountId || !workspaceId) {
      throw new AuthContextError(
        "An active workspace is required for managed enterprise AI",
        "MANAGED_WORKSPACE_REQUIRED"
      );
    }
    const apiUrl = getApiUrl()?.replace(/\/+$/, "");
    if (!apiUrl) throw new Error("OpenWhispr API URL not configured");
    const authHeaders = normalizeAuthHeaders(request.authHeaders, tokenState.token);
    if (!Object.keys(authHeaders).length) {
      throw new AuthContextError("Not authenticated", "AUTH_CONTEXT_UNVALIDATED");
    }
    const credentialHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(Object.entries(authHeaders).sort(([a], [b]) => a.localeCompare(b))))
      .digest("hex");
    const apiOrigin = new URL(apiUrl).origin;
    const cacheKey = `${apiOrigin}\n${credentialHash}\n${accountId}\n${workspaceId}`;
    return {
      accountId,
      workspaceId,
      apiUrl,
      apiOrigin,
      authHeaders,
      authGeneration: tokenState.generation,
      token: tokenState.token ?? null,
      cacheKey,
    };
  }

  function assertIdentityCurrent(identity) {
    const current = tokenStore.getState();
    if (
      current.generation !== identity.authGeneration ||
      (identity.token ? current.token !== identity.token : Boolean(current.token))
    ) {
      throw new AuthContextError("Authentication changed during managed enterprise request");
    }
  }

  function requestHeaders(identity, json = false) {
    return {
      ...identity.authHeaders,
      "x-openwhispr-version": getAppVersion(),
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await proxyFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readError(response, fallback) {
    try {
      const body = await response.json();
      return { message: body?.error || fallback, code: body?.code };
    } catch {
      return { message: fallback };
    }
  }

  async function fetchConfig(identity) {
    const url = `${identity.apiUrl}/api/workspaces/${encodeURIComponent(
      identity.workspaceId
    )}/enterprise-providers`;
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: requestHeaders(identity),
    });
    assertIdentityCurrent(identity);
    if (!response.ok) {
      const detail = await readError(response, `Managed enterprise API error: ${response.status}`);
      const error = new Error(detail.message);
      error.code =
        detail.code || (response.status === 401 ? "AUTH_EXPIRED" : "MANAGED_CONFIG_FAILED");
      error.status = response.status;
      throw error;
    }
    let body;
    try {
      body = await response.json();
    } catch (cause) {
      const error = new Error("Managed enterprise configuration response is malformed", { cause });
      error.code = "MANAGED_CONFIG_INVALID";
      throw error;
    }
    assertIdentityCurrent(identity);
    const config = validateManagedEnterpriseEnvelope(body?.data, identity.workspaceId);
    if (!config) {
      const error = new Error("Managed enterprise configuration is malformed");
      error.code = "MANAGED_CONFIG_INVALID";
      throw error;
    }
    const previous = configs.get(identity.cacheKey)?.config;
    if (previous && previous.generation !== config.generation) {
      clearIdentityCredentials(identity);
    }
    configs.set(identity.cacheKey, { config, refreshedAt: now() });
    try {
      writeCache(cachePath, identity, config);
    } catch (error) {
      logger?.warn?.("Managed enterprise configuration cache write failed", {
        error: error?.message,
      });
    }
    broadcast?.({
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      authGeneration: identity.authGeneration,
      config,
      code: null,
    });
    return { config, status: "network" };
  }

  async function resolveConfig(identity, forceRefresh = false) {
    const current = configs.get(identity.cacheKey);
    if (!forceRefresh && current && now() - current.refreshedAt < CONFIG_REFRESH_MS) {
      return { config: current.config, status: "current" };
    }
    if (configRequests.has(identity.cacheKey)) {
      return configRequests.get(identity.cacheKey);
    }
    const pending = fetchConfig(identity)
      .catch((error) => {
        if (isAuthorizationError(error) || error?.code === "MANAGED_CONFIG_INVALID") {
          const prior = configs.get(identity.cacheKey)?.config || cachedConfig(cachePath, identity);
          error.enforcementRequired =
            error?.code === "ENTERPRISE_REQUIRED" ? false : requiresEnforcedManagedAccess(prior);
          evictIdentity(identity, error.code || "MANAGED_CONFIG_FAILED", error.enforcementRequired);
          throw error;
        }
        if (!isTransientConfigError(error)) throw error;
        const memory = configs.get(identity.cacheKey)?.config;
        const disk = memory || cachedConfig(cachePath, identity);
        if (disk) {
          configs.set(identity.cacheKey, { config: disk, refreshedAt: 0 });
          return { config: disk, status: "cached" };
        }
        throw error;
      })
      .finally(() => {
        if (configRequests.get(identity.cacheKey) === pending) {
          configRequests.delete(identity.cacheKey);
        }
      });
    configRequests.set(identity.cacheKey, pending);
    return pending;
  }

  async function getConfig(request) {
    let identity;
    try {
      identity = captureIdentity(request);
      const resolved = await resolveConfig(identity, Boolean(request.forceRefresh));
      return {
        success: true,
        status: resolved.status,
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        authGeneration: identity.authGeneration,
        config: resolved.config,
      };
    } catch (error) {
      return responseError(
        error.code || "MANAGED_CONFIG_FAILED",
        error.message,
        identity,
        error.enforcementRequired
      );
    }
  }

  async function fetchAssertion(identity, provider) {
    const url = `${identity.apiUrl}/api/workspaces/${encodeURIComponent(
      identity.workspaceId
    )}/enterprise-providers/${provider}/assertion`;
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: requestHeaders(identity, true),
      body: "{}",
    });
    assertIdentityCurrent(identity);
    if (!response.ok) {
      const detail = await readError(response, `Managed identity API error: ${response.status}`);
      const error = new Error(detail.message);
      error.code =
        detail.code || (response.status === 401 ? "AUTH_EXPIRED" : "IDENTITY_EXCHANGE_FAILED");
      error.status = response.status;
      if (isAuthorizationError(error)) {
        const prior = configs.get(identity.cacheKey)?.config || cachedConfig(cachePath, identity);
        error.enforcementRequired =
          error.code === "ENTERPRISE_REQUIRED" ? false : requiresEnforcedManagedAccess(prior);
        evictIdentity(identity, error.code, error.enforcementRequired);
      }
      throw error;
    }
    const body = await response.json();
    if (typeof body?.data?.assertion !== "string") {
      throw Object.assign(new Error("Managed identity assertion is malformed"), {
        code: "IDENTITY_EXCHANGE_FAILED",
      });
    }
    return body.data.assertion;
  }

  function credentialKey(identity, generation, provider, version) {
    return `${identity.cacheKey}\n${generation}\n${provider}\n${version}`;
  }

  function usableCredential(entry) {
    return entry && entry.expiresAt - now() > CREDENTIAL_REFRESH_WINDOW_MS;
  }

  async function dedupeCredential(key, create) {
    const cached = cloudCredentials.get(key);
    if (usableCredential(cached)) return cached.value;
    if (cloudCredentialRequests.has(key)) return cloudCredentialRequests.get(key);
    const epoch = credentialEpoch;
    const pending = create()
      .then((entry) => {
        if (epoch !== credentialEpoch) {
          throw Object.assign(
            new Error("Managed enterprise configuration changed. Retry the request."),
            { code: "MANAGED_CONFIG_CHANGED" }
          );
        }
        cloudCredentials.set(key, entry);
        return entry.value;
      })
      .finally(() => {
        if (cloudCredentialRequests.get(key) === pending) cloudCredentialRequests.delete(key);
      });
    cloudCredentialRequests.set(key, pending);
    return pending;
  }

  function managedProviderFunctions(identity, resolution) {
    const record = resolution.record;
    const key = credentialKey(identity, resolution.generation, record.provider, record.version);
    if (record.provider === "bedrock") {
      return {
        credentialProvider: () =>
          dedupeCredential(key, async () => {
            const assertion = await fetchAssertion(identity, "bedrock");
            const credentials = await createAwsWebIdentityProvider({
              roleArn: record.config.roleArn,
              roleSessionName: `openwhispr-${identity.workspaceId.slice(0, 8)}`,
              webIdentityToken: assertion,
              durationSeconds: 900,
              clientConfig: { region: record.config.region },
            })();
            assertIdentityCurrent(identity);
            if (
              !credentials?.accessKeyId ||
              !credentials.secretAccessKey ||
              !credentials.sessionToken ||
              !credentials.expiration
            ) {
              throw Object.assign(new Error("AWS did not return temporary credentials"), {
                code: "IDENTITY_EXCHANGE_FAILED",
              });
            }
            return {
              value: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                sessionToken: credentials.sessionToken,
                expiration: credentials.expiration,
              },
              expiresAt: credentials.expiration.getTime(),
            };
          }),
      };
    }

    return {
      tokenProvider: () =>
        dedupeCredential(key, async () => {
          const assertion = await fetchAssertion(identity, "azure");
          const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
            record.config.tenantId
          )}/oauth2/v2.0/token`;
          const body = new URLSearchParams({
            client_id: record.config.clientId,
            grant_type: "client_credentials",
            scope: AZURE_SCOPE,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: assertion,
          });
          const response = await fetchWithTimeout(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });
          if (!response.ok) {
            const detail = await readError(
              response,
              `Microsoft identity error: ${response.status}`
            );
            throw Object.assign(new Error(detail.message), { code: "IDENTITY_EXCHANGE_FAILED" });
          }
          const token = await response.json();
          assertIdentityCurrent(identity);
          if (typeof token?.access_token !== "string" || !Number.isFinite(token?.expires_in)) {
            throw Object.assign(new Error("Microsoft identity response is malformed"), {
              code: "IDENTITY_EXCHANGE_FAILED",
            });
          }
          return {
            value: token.access_token,
            expiresAt: now() + token.expires_in * 1000,
          };
        }),
    };
  }

  async function resolveProvider(request) {
    const identity = captureIdentity(request);
    const { config } = await resolveConfig(identity);
    const resolution = resolveManagedEnterpriseScope(
      config,
      request.inferenceScope,
      request.setupMode
    );
    if (resolution.kind === "error") {
      throw Object.assign(new Error(resolution.message), { code: resolution.code });
    }
    if (resolution.kind === "manual") return { managed: false, identity, config };
    return {
      managed: true,
      identity,
      provider: resolution.provider,
      model: resolution.model,
      config: resolution.record.config,
      version: resolution.record.version,
      generation: config.generation,
      ...managedProviderFunctions(identity, { ...resolution, generation: config.generation }),
    };
  }

  function clear() {
    credentialEpoch += 1;
    configs.clear();
    configRequests.clear();
    cloudCredentials.clear();
    cloudCredentialRequests.clear();
    try {
      fs.unlinkSync(cachePath);
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn?.("Managed enterprise cache removal failed");
    }
  }

  return { getConfig, resolveProvider, clear };
}

module.exports = { createEnterpriseIdentityManager };
