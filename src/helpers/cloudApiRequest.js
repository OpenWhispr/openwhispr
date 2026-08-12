const { withPolicyRequestHeaders } = require("./policyRequestHeaders");

class AuthContextError extends Error {
  constructor(message, code = "AUTH_CONTEXT_CHANGED") {
    super(message);
    this.name = "AuthContextError";
    this.code = code;
  }
}

function authFailure(error) {
  return {
    success: false,
    error: error.message,
    code: error.code,
    status: 0,
  };
}

function captureAuthFence(tokenStore, expectedGeneration) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new AuthContextError(
      "Authenticated request has no validated credential generation",
      "AUTH_CONTEXT_UNVALIDATED"
    );
  }

  const captured = tokenStore.getState();
  if (!captured.token) {
    throw new AuthContextError(
      "Authenticated request has no bearer credential",
      "AUTH_CONTEXT_UNVALIDATED"
    );
  }
  if (captured.generation !== expectedGeneration) {
    throw new AuthContextError("Authentication context changed before request");
  }

  const assertCurrent = () => {
    const current = tokenStore.getState();
    if (current.generation !== captured.generation || current.token !== captured.token) {
      throw new AuthContextError("Authentication context changed during request");
    }
  };

  const awaitBound = async (operation) => {
    assertCurrent();
    try {
      const result = await operation();
      assertCurrent();
      return result;
    } catch (error) {
      // If both the network operation and credential context changed, the
      // auth boundary is the actionable failure and must dominate.
      assertCurrent();
      throw error;
    }
  };

  return {
    generation: captured.generation,
    authorization: `Bearer ${captured.token}`,
    assertCurrent,
    awaitBound,
  };
}

function createCloudApiRequestHandler({
  getApiUrl,
  getAppVersion,
  proxyFetch,
  tokenStore,
  logger,
}) {
  return async function handleCloudApiRequest(opts) {
    try {
      const apiUrl = getApiUrl();
      if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

      if (typeof opts?.path !== "string" || !opts.path.startsWith("/")) {
        return { success: false, error: "Invalid API path" };
      }
      const targetUrl = new URL(opts.path, apiUrl);
      if (targetUrl.origin !== new URL(apiUrl).origin) {
        return { success: false, error: "Invalid API path" };
      }
      // Concatenation (not targetUrl) preserves any base path in apiUrl; the
      // origin check above still rejects protocol-relative "//host" paths.
      const requestUrl = `${apiUrl}${opts.path}`;

      // Public calls deliberately carry no ambient bearer/cookie. They need
      // no account fence and remain usable while auth is unresolved.
      const fence = opts.public ? null : captureAuthFence(tokenStore, opts.expectedAuthGeneration);
      const method = (opts.method || "GET").toUpperCase();
      // Public invitation previews are not policy-aware and intentionally stay
      // on the legacy API contract. Authenticated cloud calls opt into policy
      // v1 using the same exact headers as direct main-process request paths.
      const headers = fence
        ? withPolicyRequestHeaders({ Authorization: fence.authorization }, getAppVersion())
        : { "x-openwhispr-version": getAppVersion() };
      const fetchOptions = {
        method,
        headers,
        useSessionCookies: false,
      };
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify(opts.body);
      }

      const response = fence
        ? await fence.awaitBound(() => proxyFetch(requestUrl, fetchOptions))
        : await proxyFetch(requestUrl, fetchOptions);

      if (response.status === 401) {
        fence?.assertCurrent();
        return {
          success: false,
          error: "Session expired",
          code: "AUTH_EXPIRED",
          status: 401,
        };
      }
      if (response.status === 503) {
        fence?.assertCurrent();
        return {
          success: false,
          error: "Service temporarily unavailable",
          code: "SERVER_ERROR",
          status: 503,
        };
      }

      const data = fence
        ? await fence.awaitBound(() => response.json().catch(() => null))
        : await response.json().catch(() => null);

      if (!response.ok) {
        fence?.assertCurrent();
        const message = data?.error?.message || data?.error || `API error: ${response.status}`;
        return {
          success: false,
          error: message,
          status: response.status,
          code: data?.code,
          details: data?.data,
          minAppVersion: data?.minAppVersion ?? data?.data?.minAppVersion,
        };
      }

      fence?.assertCurrent();
      return { success: true, data };
    } catch (error) {
      if (error instanceof AuthContextError) return authFailure(error);
      logger?.error?.(
        `Cloud API request error (${opts?.path}): ${error?.message || error} ${error?.code || ""}`.trim(),
        error?.stack
      );
      return { success: false, error: error?.message || String(error) };
    }
  };
}

module.exports = {
  AuthContextError,
  captureAuthFence,
  createCloudApiRequestHandler,
};
