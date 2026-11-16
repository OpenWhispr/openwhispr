const { readPolicyResponseError, toPolicyFailure } = require("./policyResponseError");

function createCloudConfigRequestHandler({
  getApiUrl,
  getAuthHeader,
  proxyFetch,
  withPolicyHeaders,
  logger,
  configPath,
}) {
  return async function handleCloudConfigRequest(event) {
    try {
      const apiUrl = getApiUrl();
      if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

      const authHeader = await getAuthHeader(event);
      if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

      // The caller keeps its own freshness window; a Chromium-cached copy would
      // re-serve a route the server already withdrew (e.g. after a refused
      // Orukeet session invalidates the in-memory config).
      const response = await proxyFetch(`${apiUrl}/api/${configPath}`, {
        headers: withPolicyHeaders(authHeader),
        cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 401) {
          return {
            success: false,
            error: "Session expired",
            code: "AUTH_EXPIRED",
            status: 401,
          };
        }
        if (response.status === 503) {
          return {
            success: false,
            error: "Request timed out",
            code: "SERVER_ERROR",
            status: 503,
          };
        }
        throw await readPolicyResponseError(response, `API error: ${response.status}`);
      }

      const data = await response.json();
      return { success: true, ...data };
    } catch (error) {
      logger?.error?.(`${configPath} fetch error:`, error);
      return toPolicyFailure(error);
    }
  };
}

module.exports = { createCloudConfigRequestHandler };
