const crypto = require("crypto");

// Policy requests fence cookie- or bearer-based identities (hashed headers),
// which captureAuthFence's token-only capture cannot represent — so the fence
// logic stays local here, but the error taxonomy is shared.
const { AuthContextError } = require("./cloudApiRequest");
const { isValidPolicyShape } = require("./policyValidation");
const {
  WORKSPACE_REMOVAL_CAPABILITY,
  withPolicyRequestHeaders,
} = require("./policyRequestHeaders");
const {
  readWorkspacePolicyCache,
  readAccountPolicyCache,
  writeWorkspacePolicyCache,
} = require("./workspacePolicyCache");

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
  getValidatedAccountId = () => null,
  broadcast,
  onWorkspaceRemoval = () => {},
  logger,
  requestTimeoutMs = 10_000,
  successfulRefreshMs = 5 * 60 * 1000,
  minimumAttemptIntervalMs = 5_000,
  now = Date.now,
}) {
  const snapshots = new Map();
  // Credentials with a lookup this run acted on, and whether their binding
  // vouched for the account then, which removal matching trusts over the cache.
  const lookedUp = new Map();
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
      Object.entries(authHeaders).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
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

  // Request account ids are labels (a renderer names them, and one can lag a
  // new bearer), so only this bearer's validated binding can vouch for one.
  function isValidatedAccount(identity) {
    return (
      identity.accountId !== null &&
      identity.authHeaders.Authorization === `Bearer ${identity.token}` &&
      identity.accountId === getValidatedAccountId()
    );
  }

  function cacheIdentity(identity) {
    return {
      apiOrigin: identity.apiOrigin,
      credentialHash: identity.credentialHash,
      accountId: identity.accountId,
      ...(isValidatedAccount(identity) && { accountValidated: true }),
    };
  }

  // A rotated credential has no entry of its own yet, and inherits its
  // account's last validated verdict rather than losing it.
  function rawCachedData(identity) {
    const cached = readWorkspacePolicyCache(cachePath, cacheIdentity(identity));
    if (validatePolicyData(cached)) return cached;
    if (!isValidatedAccount(identity)) return null;
    const inherited = readAccountPolicyCache(cachePath, identity);
    return validatePolicyData(inherited) ? inherited : null;
  }

  function cachedData(identity) {
    const cached = rawCachedData(identity);
    return cached?.managed === false && cached.requiresManagedPolicy === true ? null : cached;
  }

  function requiresManagedPolicy(identity) {
    if (managedPolicyRequired.has(identityKey(identity))) return true;
    const cached = rawCachedData(identity);
    if (cached?.managed === false && cached.requiresManagedPolicy === true) return true;
    return (
      readAccountPolicyCache(cachePath, identity)?.requiresManagedPolicy === true &&
      (!isValidatedAccount(identity) || !cached || cached.endpointSupported === false)
    );
  }

  // Whether the account's last validated verdict requires managed policy. A
  // failed lookup carries it, so a credential that can't inherit it yet (a rotated
  // token before its binding) still fails closed. It never grants anything,
  // so a renderer's account label is enough to read it by.
  function accountWasManaged(accountId) {
    const apiUrl = getApiUrl();
    if (!accountId || !URL.canParse(apiUrl)) return false;
    const cached = readAccountPolicyCache(cachePath, {
      apiOrigin: new URL(apiUrl).origin,
      accountId,
    });
    return cached?.managed === true || cached?.requiresManagedPolicy === true;
  }

  // #3030: the server says this account was removed from a managed workspace.
  // Only a device whose last managed verdict for this credential (or account)
  // named that workspace acts on it: a removal from some other workspace, or a
  // sign-in on another device, wipes nothing. Once a lookup has run, that is the
  // verdict this run enforces, which a failed cache write may have left off
  // disk, and while that lookup came before the credential's binding, its
  // account's last verdict too, which nothing has been matched against yet.
  // Without one, the cached verdicts count, the credential's own still counting
  // once a rejected session has cleared the account label. A removal the app
  // couldn't record throws, so the verdict that names its workspace isn't
  // replaced and the next lookup reports it again.
  function reportRemoval(identity, removal) {
    if (typeof removal?.workspaceId !== "string" || !validTimestamp(removal.removedAt)) return;
    const key = identityKey(identity);
    const account = isValidatedAccount(identity) && readAccountPolicyCache(cachePath, identity);
    const verdicts = lookedUp.has(key)
      ? [snapshots.get(key)?.data, !lookedUp.get(key) && account]
      : [readWorkspacePolicyCache(cachePath, cacheIdentity(identity)), account];
    const managedBy = verdicts.flatMap((verdict) =>
      verdict?.managed && Array.isArray(verdict.managedBy) ? verdict.managedBy : []
    );
    if (!managedBy.includes(removal.workspaceId)) return;
    const recorded = onWorkspaceRemoval({
      accountId: identity.accountId,
      workspaceId: removal.workspaceId,
      removedAt: removal.removedAt,
    });
    if (recorded === false) throw new Error("Could not record the workspace removal");
  }

  // The removals a verdict lists, less any from a workspace the same verdict
  // says manages the account: the API reads the two apart, so a removal (or,
  // read side by side by an older API, a rejoin) between the reads can name a
  // workspace in both, and the next lookup settles it.
  function listedRemovals(data) {
    const managing = data.managed && Array.isArray(data.managedBy) ? data.managedBy : [];
    return Array.isArray(data.workspaceRemovals)
      ? data.workspaceRemovals.filter((removal) => !managing.includes(removal?.workspaceId))
      : [];
  }

  // A bound credential's verdict becomes its account's, so the removals it lists
  // are checked against the verdict it replaces first, whichever read binds it
  // (one heard before the binding, maybe in an earlier run, wasn't). A removal
  // the app couldn't record skips the write, so the next read checks it again.
  function saveVerdict(identity, data) {
    try {
      if (isValidatedAccount(identity))
        for (const removal of listedRemovals(data)) reportRemoval(identity, removal);
      writeWorkspacePolicyCache(cachePath, cacheIdentity(identity), data);
    } catch (error) {
      logger?.error?.("Policy verdict not saved", error);
    }
  }

  function errorSnapshot(identity, code, error, httpStatus) {
    const current = snapshots.get(identityKey(identity));
    return {
      success: false,
      status: "error",
      revision: current?.revision ?? revision,
      accountId: identity.accountId,
      authGeneration: identity.authGeneration,
      managed: accountWasManaged(identity.accountId),
      code,
      error,
      httpStatus,
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
    if (
      !data.managed &&
      accountWasManaged(identity.accountId) &&
      (data.endpointSupported === false || !isValidatedAccount(identity))
    )
      return errorSnapshot(
        identity,
        requiresManagedPolicy(identity) ? "POLICY_UNRESOLVABLE" : "POLICY_UNAVAILABLE",
        "Organization policy was previously required"
      );
    // A policy can arrive before its bearer is bound. Its first validated
    // read must replace the account's older restrictive evidence too.
    if (
      !data.managed &&
      data.endpointSupported !== false &&
      isValidatedAccount(identity) &&
      accountWasManaged(identity.accountId)
    ) {
      saveVerdict(identity, data);
    }
    // A managed one replaces it only at the next lookup, but the removals it
    // lists are checked against it once the bearer is bound, not minutes
    // later; from then on the binding vouches for the lookup.
    const key = identityKey(identity);
    if (data.managed && lookedUp.get(key) === false && isValidatedAccount(identity)) {
      try {
        for (const removal of listedRemovals(data)) reportRemoval(identity, removal);
        lookedUp.set(key, true);
      } catch (error) {
        logger?.error?.("Workspace removal not recorded", error);
      }
    }
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
    saveVerdict(identity, data);
    const result = publicSnapshot(identity, data, status, revision);
    broadcast?.(result);
    return result;
  }

  function acceptSuccessfulResponse(identity, data, status) {
    managedPolicyRequired.delete(identityKey(identity));
    // A stale (anti-downgraded) response is still a successful server round
    // trip; recording it keeps the refresh TTL engaged behind lagging replicas.
    successfulRefreshes.set(identityKey(identity), now());
    // What publicSnapshot acts on.
    if (
      data.managed ||
      !accountWasManaged(identity.accountId) ||
      (data.endpointSupported !== false && isValidatedAccount(identity))
    )
      lookedUp.set(identityKey(identity), isValidatedAccount(identity));
    return accept(identity, data, status);
  }

  async function fetchPolicy(identity) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        // This manager keeps its own freshness window; a Chromium-cached copy
        // (the endpoint allows max-age=300) would answer a refresh after a
        // server refusal with the verdict the server just contradicted.
        const response = await proxyFetch(`${identity.apiUrl}/api/workspace-policy`, {
          method: "GET",
          headers: withPolicyRequestHeaders(identity.authHeaders, getAppVersion(), [
            WORKSPACE_REMOVAL_CAPABILITY,
          ]),
          cache: "no-store",
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
          // The body can arrive after an account switch, which its removal mustn't reach.
          assertIdentityCurrent(identity);
          if (errorBody?.code === "POLICY_UNRESOLVABLE") {
            throw unresolvablePolicyError(errorBody.error || "Organization policy is unresolvable");
          }
          // An admin removal revoked this session. The API names every removal
          // behind it in workspaceRemovals; an older one names only the newest.
          if (response.status === 401 && errorBody?.code === "WORKSPACE_MEMBER_REMOVED") {
            const removals = Array.isArray(errorBody.workspaceRemovals)
              ? errorBody.workspaceRemovals
              : [errorBody];
            for (const removal of removals) reportRemoval(identity, removal);
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
        // Still signed in (directory deprovisioning keeps the session), maybe
        // still managed by another workspace; read before this verdict replaces
        // the one that named the removing workspace. The newest removal may be
        // from a workspace that never managed this device, so every listed one
        // is checked.
        for (const removal of listedRemovals(data)) reportRemoval(identity, removal);
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

      if (error?.code === "POLICY_UNRESOLVABLE") markManagedPolicyRequired(identity, error.message);
      // Once the server has called this identity unresolvable, only a managed
      // verdict stands in, whatever failed this time: a dropped connection
      // mustn't bring back the unmanaged one.
      const managedOnly = requiresManagedPolicy(identity);
      // Prefer the in-memory verdict; the disk cache only backs it up, so an
      // unreadable cache file must not discard a valid session snapshot.
      const current = snapshots.get(identityKey(identity));
      if (current && (!managedOnly || current.data.managed)) {
        return publicSnapshot(identity, current.data, "cached", current.revision);
      }
      const cached = cachedData(identity);
      if (cached && (!managedOnly || cached.managed)) {
        return accept(identity, cached, "cached");
      }
      logger?.warn?.("Workspace policy unavailable", { error: error?.message });
      const code = managedOnly ? "POLICY_UNRESOLVABLE" : error?.code || "POLICY_UNAVAILABLE";
      return errorSnapshot(identity, code, error?.message || String(error), error?.status);
    }
  }

  async function getPolicy(request) {
    let identity;
    try {
      identity = captureIdentity(request ?? {});
    } catch (error) {
      const accountId = normalizeAccountId(request?.accountId);
      return {
        success: false,
        status: "error",
        revision,
        accountId,
        authGeneration: tokenStore.getState()?.generation ?? null,
        managed: accountWasManaged(accountId),
        code: error.code || "POLICY_UNAVAILABLE",
        error: error.message,
      };
    }
    const key = identityKey(identity);
    const current = snapshots.get(key);
    const lastSuccessfulRefresh = successfulRefreshes.get(key);
    const successfulRefreshAge =
      lastSuccessfulRefresh === undefined ? null : now() - lastSuccessfulRefresh;
    // `refresh` is for a caller the server just refused: the fresh verdict it
    // holds is the one in question. The attempt throttle below still applies.
    if (
      !request.refresh &&
      current &&
      !(current.data.managed === false && requiresManagedPolicy(identity)) &&
      successfulRefreshAge !== null &&
      successfulRefreshAge >= 0 &&
      successfulRefreshAge < successfulRefreshMs
    ) {
      return publicSnapshot(identity, current.data, "current", current.revision);
    }
    if (inFlight.has(key)) {
      // The verdict the lookup left, not its summary: the summary lists no
      // removals for a joiner bound since to check.
      return inFlight.get(key).then((result) => {
        if (!result.success) return result;
        const settled = snapshots.get(key);
        return publicSnapshot(identity, settled.data, result.status, settled.revision);
      });
    }
    const lastAttempt = lastAttempts.get(key);
    const attemptAge = lastAttempt === undefined ? null : now() - lastAttempt.startedAt;
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
        "Workspace policy refresh is rate limited",
        lastAttempt.httpStatus
      );
    }
    const attempt = { startedAt: now() };
    lastAttempts.set(key, attempt);
    const pending = fetchPolicy(identity)
      .then((result) => {
        attempt.httpStatus = result.httpStatus;
        return result;
      })
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
    return pending;
  }

  // The verdict already held in memory for this identity, without a refresh,
  // for callers with a hard deadline whose refresh is taking too long.
  function peekPolicy(request) {
    let identity;
    try {
      identity = captureIdentity(request ?? {});
    } catch {
      return null;
    }
    const current = snapshots.get(identityKey(identity));
    if (!current || (current.data.managed === false && requiresManagedPolicy(identity))) {
      return null;
    }
    return publicSnapshot(identity, current.data, "cached", current.revision);
  }

  // What this identity last had, in memory or on disk, for a caller that can't
  // wait on the network. It decides nothing about freshness: the caller refreshes.
  function heldPolicy(request) {
    let identity;
    try {
      identity = captureIdentity(request ?? {});
    } catch {
      return null;
    }
    const managedOnly = requiresManagedPolicy(identity);
    const current = snapshots.get(identityKey(identity));
    if (current && (!managedOnly || current.data.managed)) {
      return publicSnapshot(identity, current.data, "cached", current.revision);
    }
    const cached = cachedData(identity);
    return cached && (!managedOnly || cached.managed) ? accept(identity, cached, "cached") : null;
  }

  return { getPolicy, peekPolicy, heldPolicy, accountWasManaged };
}

// Main-process capture gate: block an explicit managed denial or an
// unresolved managed policy; guests and unmanaged users keep the feature.
function isScreenContextBlocked(snapshot) {
  return (
    snapshot.code === "POLICY_UNRESOLVABLE" ||
    Boolean(snapshot.managed && snapshot.policy?.features?.screenContextEnabled === false)
  );
}

module.exports = { createWorkspacePolicyManager, isScreenContextBlocked };
