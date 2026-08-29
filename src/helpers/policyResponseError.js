function errorMessage(payload, fallback) {
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  if (typeof payload?.error?.message === "string" && payload.error.message) {
    return payload.error.message;
  }
  if (typeof payload?.message === "string" && payload.message) return payload.message;
  return fallback;
}

function createPolicyResponseError(status, payload, fallback) {
  const code = payload?.code ?? payload?.error?.code;
  const details = payload?.data;
  const minAppVersion =
    payload?.minAppVersion ?? details?.minAppVersion ?? payload?.error?.minAppVersion;
  const safeStatus = Number.isInteger(status) ? status : 500;
  return Object.assign(new Error(errorMessage(payload, fallback)), {
    ...(code ? { code } : {}),
    status: safeStatus,
    statusCode: safeStatus,
    ...(minAppVersion ? { minAppVersion } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

async function readPolicyResponseError(response, fallback) {
  if (!response || typeof response !== "object") {
    return createPolicyResponseError(500, null, fallback);
  }
  const payload = typeof response.json === "function" ? await response.json().catch(() => null) : null;
  return createPolicyResponseError(response.status, payload, fallback);
}

function toPolicyFailure(error) {
  const message =
    (typeof error === "string" ? error : error?.message) || "Unknown error";
  return {
    success: false,
    error: message,
    ...(error?.code ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(error?.minAppVersion ? { minAppVersion: error.minAppVersion } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

module.exports = { createPolicyResponseError, readPolicyResponseError, toPolicyFailure };
