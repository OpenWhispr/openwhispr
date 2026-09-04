const { readPolicyResponseError, toPolicyFailure } = require("./policyResponseError");
const { checkCloudPreconditions } = require("./cloudPreconditions");

function createCloudConfigRequestHandler({
  getApiUrl,
  getAuthHeader,
  proxyFetch,
  withPolicyHeaders,
  logger,
  configPath,
}) {
  return async function handleCloudConfigRequest(event) {
    // No API URL (local-only install) and no auth header (session not ready at
    // first paint) are expected states, not failures. Returning them at debug
    // level keeps a healthy launch quiet; a thrown error would land in the
    // catch below and log at error level on every startup.
    const apiUrl = getApiUrl();
    const authHeader = apiUrl ? await getAuthHeader(event) : {};
    const gate = checkCloudPreconditions(apiUrl, authHeader);
    if (!gate.ok) {
      logger?.debug?.(`${configPath} unavailable`, { code: gate.result.code });
      return gate.result;
    }

    try {
      const response = await proxyFetch(`${apiUrl}/api/${configPath}`, {
        headers: withPolicyHeaders(authHeader),
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
