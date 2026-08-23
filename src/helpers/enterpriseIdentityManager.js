const crypto = require("crypto");
const fs = require("fs");
const { isDeepStrictEqual } = require("util");
const {
  resolveManagedEnterpriseScope,
  validateManagedEnterpriseEnvelope,
} = require("./enterpriseManagedConfig.mjs");
const { AuthContextError } = require("./cloudApiRequest");

const CONFIG_CACHE_VERSION = 1;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const CREDENTIAL_REFRESH_WINDOW_MS = 60 * 1000;
const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default";
const AUTHORIZATION_ERROR_CODES = new Set([
  "AUTH_EXPIRED",
  "ENTERPRISE_REQUIRED",
  "SSO_REQUIRED",
  "DIRECTORY_ASSIGNMENT_REQUIRED",
  "PROVIDER_NOT_ALLOWED",
  "PROVIDER_NOT_CONFIGURED",
  "POLICY_UNRESOLVABLE",
]);
const LOCALIZED_CONFIG_ERROR_CODES = new Set([
  ...AUTHORIZATION_ERROR_CODES,
  "AUTH_CONTEXT_CHANGED",
  "AUTH_CONTEXT_UNVALIDATED",
  "MANAGED_WORKSPACE_REQUIRED",
  "MANAGED_CONFIG_INVALID",
  "MANAGED_CONFIG_UNAVAILABLE",
  "MANAGED_ENTERPRISE_UNSUPPORTED",
]);

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

function writeCacheEntry(cachePath, identity, entry) {
  const envelope = readCache(cachePath);
  const entries = envelope.entries.filter((entry) => entry?.key !== identity.cacheKey);
  entries.push({ key: identity.cacheKey, workspaceId: identity.workspaceId, ...entry });
  fs.writeFileSync(cachePath, JSON.stringify({ version: CONFIG_CACHE_VERSION, entries }), {
    mode: 0o600,
  });
}

function writeCache(cachePath, identity, config) {
  writeCacheEntry(cachePath, identity, { config });
}

function writeUnmanagedVerdict(cachePath, identity) {
  writeCacheEntry(cachePath, identity, { config: null, enforcementRequired: false });
}

function cachedConfig(cachePath, identity) {
  const entry = readCache(cachePath).entries.find(
    (candidate) => candidate?.key === identity.cacheKey
  );
  return validateManagedEnterpriseEnvelope(entry?.config, identity.workspaceId);
}

function cachedEnforcementRequired(cachePath, identity) {
  const entry = readCache(cachePath).entries.find(
    (candidate) => candidate?.key === identity.cacheKey
  );
  return typeof entry?.enforcementRequired === "boolean" ? entry.enforcementRequired : undefined;
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
  return [401, 403, 404].includes(error?.status) || AUTHORIZATION_ERROR_CODES.has(error?.code);
}

function resolveConfigResponseErrorCode(detail, status) {
  if (detail.hasServerDetail) {
    return detail.code || (status === 401 ? "AUTH_EXPIRED" : "MANAGED_CONFIG_FAILED");
  }
  if (LOCALIZED_CONFIG_ERROR_CODES.has(detail.code)) return detail.code;
  return !detail.code && status === 401 ? "AUTH_EXPIRED" : "MANAGED_CONFIG_UNAVAILABLE";
}

function requiresEnforcedManagedAccess(config) {
  return Boolean(
    config?.localModels?.transcription?.length ||
    config?.localModels?.reasoning?.length ||
    config?.providers?.some(
      (record) =>
        record.mode !== "disabled" &&
        (record.mode === "managed_required" || !record.allowManualSetup)
    )
  );
}

function resolveEnforcementRequired(errorCode, prior, knownRequired) {
  if (errorCode === "ENTERPRISE_REQUIRED") return false;
  if (knownRequired || requiresEnforcedManagedAccess(prior)) return true;
  return undefined;
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
  const enforcedConfigRequired = new Set();
  const authoritativelyUnmanaged = new Set();
  const invalidatedCacheEntries = new Set();
  const authorizationSnapshots = new Map();
  let credentialEpoch = 0;
  let configRequestEpoch = 0;

  function assertConfigRequestCurrent(epoch) {
    if (epoch !== configRequestEpoch) {
      throw new AuthContextError("Managed enterprise request was cleared before completion");
    }
  }

  function assertCredentialRequestCurrent(epoch) {
    if (epoch !== credentialEpoch) {
      throw Object.assign(
        new Error("Managed enterprise configuration changed. Retry the request."),
        { code: "MANAGED_CONFIG_CHANGED" }
      );
    }
  }

  function cachedConfigIfCurrent(identity) {
    return invalidatedCacheEntries.has(identity.cacheKey)
      ? null
      : cachedConfig(cachePath, identity);
  }

  function cachedEnforcementIfCurrent(identity) {
    return invalidatedCacheEntries.has(identity.cacheKey)
      ? undefined
      : cachedEnforcementRequired(cachePath, identity);
  }

  function broadcastAuthorizationChange(identity, snapshot) {
    const previous = authorizationSnapshots.get(identity.cacheKey);
    const current = {
      config: snapshot.config ?? null,
      code: snapshot.code ?? null,
      ...(typeof snapshot.enforcementRequired === "boolean"
        ? { enforcementRequired: snapshot.enforcementRequired }
        : {}),
    };
    if (previous && isDeepStrictEqual(previous, current)) return;
    authorizationSnapshots.set(identity.cacheKey, current);
    broadcast?.({
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      authGeneration: identity.authGeneration,
      ...current,
    });
  }

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

  function evictIdentity(identity, code, enforcementRequired) {
    configs.delete(identity.cacheKey);
    configRequests.delete(identity.cacheKey);
    clearIdentityCredentials(identity);
    if (enforcementRequired === false) {
      authoritativelyUnmanaged.add(identity.cacheKey);
      invalidatedCacheEntries.add(identity.cacheKey);
      try {
        writeUnmanagedVerdict(cachePath, identity);
        invalidatedCacheEntries.delete(identity.cacheKey);
      } catch {
        // A read-only cache must never prevent the in-memory verdict.
      }
    } else {
      authoritativelyUnmanaged.delete(identity.cacheKey);
      invalidatedCacheEntries.add(identity.cacheKey);
      removeCachedConfig(cachePath, identity);
    }
    broadcastAuthorizationChange(identity, {
      config: null,
      code,
      ...(typeof enforcementRequired === "boolean" ? { enforcementRequired } : {}),
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
    if (!apiUrl) {
      throw Object.assign(new Error("OpenWhispr API URL not configured"), {
        code: "MANAGED_CONFIG_UNAVAILABLE",
      });
    }
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
      const hasServerDetail = Boolean(body?.error);
      return {
        message: body?.error || fallback,
        code: body?.code,
        hasServerDetail,
      };
    } catch {
      return { message: fallback, hasServerDetail: false };
    }
  }

  async function fetchConfig(identity, requestEpoch) {
    const url = `${identity.apiUrl}/api/workspaces/${encodeURIComponent(
      identity.workspaceId
    )}/enterprise-providers`;
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: requestHeaders(identity),
    });
    assertConfigRequestCurrent(requestEpoch);
    assertIdentityCurrent(identity);
    if (!response.ok) {
      const detail = await readError(response, `Managed enterprise API error: ${response.status}`);
      const error = new Error(detail.message);
      error.code = resolveConfigResponseErrorCode(detail, response.status);
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
    assertConfigRequestCurrent(requestEpoch);
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
    authoritativelyUnmanaged.delete(identity.cacheKey);
    invalidatedCacheEntries.add(identity.cacheKey);
    if (requiresEnforcedManagedAccess(config)) enforcedConfigRequired.add(identity.cacheKey);
    else enforcedConfigRequired.delete(identity.cacheKey);
    try {
      writeCache(cachePath, identity, config);
      invalidatedCacheEntries.delete(identity.cacheKey);
    } catch (error) {
      logger?.warn?.("Managed enterprise configuration cache write failed", {
        error: error?.message,
      });
    }
    broadcastAuthorizationChange(identity, { config, code: null });
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
    const requestEpoch = configRequestEpoch;
    const pending = fetchConfig(identity, requestEpoch)
      .catch((error) => {
        assertConfigRequestCurrent(requestEpoch);
        if (isAuthorizationError(error) || error?.code === "MANAGED_CONFIG_INVALID") {
          const prior = configs.get(identity.cacheKey)?.config || cachedConfigIfCurrent(identity);
          error.enforcementRequired = resolveEnforcementRequired(
            error?.code,
            prior,
            enforcedConfigRequired.has(identity.cacheKey)
          );
          if (error.enforcementRequired === true) enforcedConfigRequired.add(identity.cacheKey);
          else if (error.enforcementRequired === false)
            enforcedConfigRequired.delete(identity.cacheKey);
          evictIdentity(identity, error.code || "MANAGED_CONFIG_FAILED", error.enforcementRequired);
          throw error;
        }
        if (!isTransientConfigError(error)) throw error;
        const memory = configs.get(identity.cacheKey)?.config;
        const disk = memory || cachedConfigIfCurrent(identity);
        if (disk) {
          configs.set(identity.cacheKey, { config: disk, refreshedAt: 0 });
          return { config: disk, status: "cached" };
        }
        if (
          authoritativelyUnmanaged.has(identity.cacheKey) ||
          cachedEnforcementIfCurrent(identity) === false
        ) {
          return { config: null, status: "known-unmanaged" };
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
    const requestEpoch = configRequestEpoch;
    try {
      identity = captureIdentity(request);
      const resolved = await resolveConfig(identity, Boolean(request.forceRefresh));
      assertConfigRequestCurrent(requestEpoch);
      if (resolved.status === "known-unmanaged") {
        return responseError(
          "ENTERPRISE_REQUIRED",
          "An active Enterprise workspace is required",
          identity,
          false
        );
      }
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

  async function fetchAssertion(identity, provider, requestEpoch) {
    const url = `${identity.apiUrl}/api/workspaces/${encodeURIComponent(
      identity.workspaceId
    )}/enterprise-providers/${provider}/assertion`;
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: requestHeaders(identity, true),
      body: "{}",
    });
    assertCredentialRequestCurrent(requestEpoch);
    assertIdentityCurrent(identity);
    if (!response.ok) {
      const detail = await readError(response, `Managed identity API error: ${response.status}`);
      assertCredentialRequestCurrent(requestEpoch);
      const error = new Error(detail.message);
      error.code =
        detail.code || (response.status === 401 ? "AUTH_EXPIRED" : "IDENTITY_EXCHANGE_FAILED");
      error.status = response.status;
      if (isAuthorizationError(error)) {
        const prior = configs.get(identity.cacheKey)?.config || cachedConfigIfCurrent(identity);
        error.enforcementRequired = resolveEnforcementRequired(
          error.code,
          prior,
          enforcedConfigRequired.has(identity.cacheKey)
        );
        if (error.enforcementRequired === true) enforcedConfigRequired.add(identity.cacheKey);
        else if (error.enforcementRequired === false)
          enforcedConfigRequired.delete(identity.cacheKey);
        evictIdentity(identity, error.code, error.enforcementRequired);
      }
      throw error;
    }
    const body = await response.json();
    assertCredentialRequestCurrent(requestEpoch);
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
    const pending = create(epoch)
      .then((entry) => {
        assertCredentialRequestCurrent(epoch);
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
          dedupeCredential(key, async (requestEpoch) => {
            const assertion = await fetchAssertion(identity, "bedrock", requestEpoch);
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
        dedupeCredential(key, async (requestEpoch) => {
          const assertion = await fetchAssertion(identity, "azure", requestEpoch);
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
    const requestEpoch = configRequestEpoch;
    const identity = captureIdentity(request);
    const { config } = await resolveConfig(identity);
    assertConfigRequestCurrent(requestEpoch);
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
    configRequestEpoch += 1;
    credentialEpoch += 1;
    for (const entry of readCache(cachePath).entries) {
      if (typeof entry?.key === "string") invalidatedCacheEntries.add(entry.key);
    }
    for (const key of configs.keys()) invalidatedCacheEntries.add(key);
    for (const key of authoritativelyUnmanaged) invalidatedCacheEntries.add(key);
    configs.clear();
    configRequests.clear();
    cloudCredentials.clear();
    cloudCredentialRequests.clear();
    enforcedConfigRequired.clear();
    authoritativelyUnmanaged.clear();
    authorizationSnapshots.clear();
    try {
      fs.unlinkSync(cachePath);
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn?.("Managed enterprise cache removal failed");
    }
  }

  return { getConfig, resolveProvider, clear };
}

module.exports = { createEnterpriseIdentityManager };
