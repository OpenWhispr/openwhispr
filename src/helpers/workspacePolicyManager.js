const crypto = require("crypto");

// Policy requests fence cookie- or bearer-based identities (hashed headers),
// which captureAuthFence's token-only capture cannot represent — so the fence
// logic stays local here, but the error taxonomy is shared.
const { AuthContextError } = require("./cloudApiRequest");
const { isValidPolicyShape } = require("./policyValidation");
const { withPolicyRequestHeaders } = require("./policyRequestHeaders");
const { readWorkspacePolicyCache, writeWorkspacePolicyCache } = require("./workspacePolicyCache");

function unresolvablePolicyError(message) {
  return Object.assign(new Error(message), { code: "POLICY_UNRESOLVABLE" });
}

function normalizeAccountId(value) {
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

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validatePolicyData(value) {
  if (!value || typeof value !== "object" || typeof value.managed !== "boolean") return false;
  if (value.managed) {
    return isValidPolicyShape(value.policy) && validTimestamp(value.policyUpdatedAt);
  }
  return (
    (value.policy === null || value.policy === undefined || isValidPolicyShape(value.policy)) &&
    value.policyUpdatedAt == null
  );
}

function createWorkspacePolicyManager({
  cachePath,
  getApiUrl,
  getAppVersion,
  proxyFetch,
  tokenStore,
  broadcast,
  logger,
  requestTimeoutMs = 10_000,
  successfulRefreshMs = 5 * 60 * 1000,
  minimumAttemptIntervalMs = 5_000,
  now = Date.now,
}) {
  const snapshots = new Map();
  const inFlight = new Map();
  const successfulRefreshes = new Map();
  const lastAttempts = new Map();
  const managedPolicyRequired = new Set();
  let revision = 0;

  function captureIdentity(request = {}) {
    const tokenState = tokenStore.getState();
    if (
      !Number.isSafeInteger(request.expectedAuthGeneration) ||
      request.expectedAuthGeneration < 0
    ) {
      throw new AuthContextError(
        "Authenticated policy request has no validated credential generation",
        "AUTH_CONTEXT_UNVALIDATED"
      );
    }
    if (request.expectedAuthGeneration !== tokenState.generation) {
      throw new AuthContextError("Authentication context changed before policy request");
    }
    const apiUrl = getApiUrl();
    if (!apiUrl) throw new Error("OpenWhispr API URL not configured");
    const authHeaders = normalizeAuthHeaders(request.authHeaders, tokenState?.token);
    if (!Object.keys(authHeaders).length) {
      throw new AuthContextError(
        "Authenticated policy request has no credential",
        "AUTH_CONTEXT_UNVALIDATED"
      );
    }
    const apiOrigin = new URL(apiUrl).origin;
    const accountId = normalizeAccountId(request.accountId);
    const credentialMaterial = JSON.stringify(
      Object.entries(authHeaders).sort(([left], [right]) => left.localeCompare(right))
    );
    const credentialHash = crypto.createHash("sha256").update(credentialMaterial).digest("hex");
    return {
      accountId,
      apiUrl: apiUrl.replace(/\/+$/, ""),
      apiOrigin,
      credentialHash,
      authHeaders,
      token: tokenState?.token ?? null,
      authGeneration: tokenState.generation,
    };
  }

  function assertIdentityCurrent(identity) {
    const current = tokenStore.getState();
    if (
      current?.generation !== identity.authGeneration ||
      (identity.token ? current?.token !== identity.token : Boolean(current?.token))
    ) {
      throw new AuthContextError("Authentication context changed during policy request");
    }
  }

  function identityKey(identity) {
    return `${identity.apiOrigin}\n${identity.credentialHash}`;
  }

  function cacheIdentity(identity) {
    return {
      apiOrigin: identity.apiOrigin,
      credentialHash: identity.credentialHash,
      accountId: identity.accountId,
    };
  }

  function rawCachedData(identity) {
    const cached = readWorkspacePolicyCache(cachePath, cacheIdentity(identity));
    return validatePolicyData(cached) ? cached : null;
  }

  function cachedData(identity) {
    const cached = rawCachedData(identity);
    return cached?.managed === false && cached.requiresManagedPolicy === true ? null : cached;
  }

  function requiresManagedPolicy(identity) {
    if (managedPolicyRequired.has(identityKey(identity))) return true;
    const cached = rawCachedData(identity);
    return cached?.managed === false && cached.requiresManagedPolicy === true;
  }

  function errorSnapshot(identity, code, error) {
    const current = snapshots.get(identityKey(identity));
    return {
      success: false,
      status: "error",
      revision: current?.revision ?? revision,
      accountId: identity.accountId,
      authGeneration: identity.authGeneration,
      code,
      error,
    };
  }

  function markManagedPolicyRequired(identity, message) {
    const key = identityKey(identity);
    const current = snapshots.get(key);
    const cached = rawCachedData(identity);
    if (current?.data.managed || cached?.managed) return;

    const wasRequired = requiresManagedPolicy(identity);
    managedPolicyRequired.add(key);
    if (!wasRequired) {
      try {
        // A first-ever unresolvable verdict has nothing cached to mark, so seed
        // an unmanaged entry; without it a restart fails open on 404/501.
        writeWorkspacePolicyCache(cachePath, cacheIdentity(identity), {
          ...(cached ?? { managed: false, policy: null, policyUpdatedAt: null }),
          requiresManagedPolicy: true,
        });
      } catch (error) {
        logger?.error?.("Policy fail-closed marker write failed", error);
      }
      broadcast?.(errorSnapshot(identity, "POLICY_UNRESOLVABLE", message));
    }
  }

  function publicSnapshot(identity, data, status, snapshotRevision) {
    return {
      success: true,
      status,
      revision: snapshotRevision,
      accountId: identity.accountId,
      authGeneration: identity.authGeneration,
      managed: data.managed,
      policy: data.policy ?? null,
      policyUpdatedAt: data.policyUpdatedAt ?? null,
      endpointSupported: data.endpointSupported !== false,
    };
  }

  function accept(identity, data, status) {
    const key = identityKey(identity);
    let current = snapshots.get(key);
    if (!current) {
      const cached = cachedData(identity);
      if (cached) {
        current = { data: cached, revision };
        snapshots.set(key, current);
      }
    }
    if (
      current?.data.managed &&
      data.managed &&
      validTimestamp(current.data.policyUpdatedAt) &&
      validTimestamp(data.policyUpdatedAt) &&
      Date.parse(data.policyUpdatedAt) < Date.parse(current.data.policyUpdatedAt)
    ) {
      return publicSnapshot(identity, current.data, "current", current.revision);
    }

    revision += 1;
    const next = { data, revision };
    snapshots.set(key, next);
    try {
      writeWorkspacePolicyCache(cachePath, cacheIdentity(identity), data);
    } catch (error) {
      logger?.error?.("Policy cache write failed", error);
    }
    const result = publicSnapshot(identity, data, status, revision);
    broadcast?.(result);
    return result;
  }

  function acceptSuccessfulResponse(identity, data, status) {
    managedPolicyRequired.delete(identityKey(identity));
    // A stale (anti-downgraded) response is still a successful server round
    // trip; recording it keeps the refresh TTL engaged behind lagging replicas.
    successfulRefreshes.set(identityKey(identity), now());
    return accept(identity, data, status);
  }

  async function fetchPolicy(identity) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await proxyFetch(`${identity.apiUrl}/api/workspace-policy`, {
          method: "GET",
          headers: withPolicyRequestHeaders(identity.authHeaders, getAppVersion()),
          signal: controller.signal,
        });
        assertIdentityCurrent(identity);

        if (response.status === 404 || response.status === 501) {
          const current = snapshots.get(identityKey(identity));
          if (current?.data.managed) {
            return publicSnapshot(identity, current.data, "cached", current.revision);
          }
          if (requiresManagedPolicy(identity)) {
            throw unresolvablePolicyError("Organization policy was previously unresolved");
          }
          const cached = cachedData(identity);
          if (cached?.managed) return accept(identity, cached, "cached");
          return acceptSuccessfulResponse(
            identity,
            { managed: false, policy: null, policyUpdatedAt: null, endpointSupported: false },
            "unsupported"
          );
        }
        if (!response.ok) {
          let errorBody = null;
          try {
            errorBody = await response.json();
          } catch {}
          if (errorBody?.code === "POLICY_UNRESOLVABLE") {
            throw unresolvablePolicyError(errorBody.error || "Organization policy is unresolvable");
          }
          const error = new Error(`API error: ${response.status}`);
          error.status = response.status;
          throw error;
        }

        const json = await response.json();
        assertIdentityCurrent(identity);
        const data = {
          ...json?.data,
          endpointSupported: true,
        };
        if (!validatePolicyData(data)) {
          if (data.managed === true) {
            throw unresolvablePolicyError("Managed policy response is malformed");
          }
          throw new Error("Malformed policy response");
        }
        return acceptSuccessfulResponse(identity, data, "network");
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      try {
        assertIdentityCurrent(identity);
      } catch (authContextError) {
        return errorSnapshot(identity, authContextError.code, authContextError.message);
      }

      const requiresManagedFallback = error?.code === "POLICY_UNRESOLVABLE";
      if (requiresManagedFallback) markManagedPolicyRequired(identity, error.message);
      // Prefer the in-memory verdict; the disk cache only backs it up, so an
      // unreadable cache file must not discard a valid session snapshot.
      const current = snapshots.get(identityKey(identity));
      if (current && (!requiresManagedFallback || current.data.managed)) {
        return publicSnapshot(identity, current.data, "cached", current.revision);
      }
      const cached = cachedData(identity);
      if (cached && (!requiresManagedFallback || cached.managed)) {
        return accept(identity, cached, "cached");
      }
      logger?.warn?.("Workspace policy unavailable", { error: error?.message });
      const code = requiresManagedPolicy(identity)
        ? "POLICY_UNRESOLVABLE"
        : error?.code || "POLICY_UNAVAILABLE";
      return errorSnapshot(identity, code, error?.message || String(error));
    }
  }

  async function getPolicy(request) {
    let identity;
    try {
      identity = captureIdentity(request ?? {});
    } catch (error) {
      return {
        success: false,
        status: "error",
        revision,
        accountId: normalizeAccountId(request?.accountId),
        authGeneration: tokenStore.getState()?.generation ?? null,
        code: error.code || "POLICY_UNAVAILABLE",
        error: error.message,
      };
    }
    const key = identityKey(identity);
    const current = snapshots.get(key);
    const lastSuccessfulRefresh = successfulRefreshes.get(key);
    const successfulRefreshAge =
      lastSuccessfulRefresh === undefined ? null : now() - lastSuccessfulRefresh;
    if (
      current &&
      !(current.data.managed === false && requiresManagedPolicy(identity)) &&
      successfulRefreshAge !== null &&
      successfulRefreshAge >= 0 &&
      successfulRefreshAge < successfulRefreshMs
    ) {
      return publicSnapshot(identity, current.data, "current", current.revision);
    }
    if (inFlight.has(key)) {
      return inFlight.get(key).then((result) =>
        result.success
          ? {
              ...result,
              accountId: identity.accountId,
              authGeneration: identity.authGeneration,
            }
          : result
      );
    }
    const lastAttempt = lastAttempts.get(key);
    const attemptAge = lastAttempt === undefined ? null : now() - lastAttempt;
    const attemptIsThrottled =
      attemptAge !== null && attemptAge >= 0 && attemptAge < minimumAttemptIntervalMs;
    if (attemptIsThrottled) {
      if (requiresManagedPolicy(identity)) {
        return errorSnapshot(
          identity,
          "POLICY_UNRESOLVABLE",
          "Organization policy is awaiting a successful refresh"
        );
      }
      if (current) return publicSnapshot(identity, current.data, "cached", current.revision);
      const cached = cachedData(identity);
      if (cached) return accept(identity, cached, "cached");
      return errorSnapshot(
        identity,
        "POLICY_RETRY_THROTTLED",
        "Workspace policy refresh is rate limited"
      );
    }
    lastAttempts.set(key, now());
    const pending = fetchPolicy(identity).finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  return { getPolicy };
}

// Main-process capture gate: block an explicit managed denial or an
// unresolved managed policy; guests and unmanaged users keep the feature.
function isScreenContextBlocked(snapshot) {
  return (
    snapshot.code === "POLICY_UNRESOLVABLE" ||
    Boolean(
      snapshot.success &&
      snapshot.managed &&
      snapshot.policy?.features?.screenContextEnabled === false
    )
  );
}

module.exports = { createWorkspacePolicyManager, isScreenContextBlocked };
