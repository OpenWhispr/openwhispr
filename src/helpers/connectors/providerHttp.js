// The request plumbing Gmail's and Linear's clients share: one timed POST
// whose transport failure is already classified, and the body helpers.
const { classifyTransportError, transportErrorCode } = require("./deliveryClassifier");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Error statuses can carry an empty or non-JSON body.
async function readJson(response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function formBody(params) {
  const defined = Object.entries(params ?? {}).filter(
    ([, value]) => value !== undefined && value !== null
  );
  return new URLSearchParams(defined).toString();
}

// `{ response }`, or `{ response: null, failure }` when the request never got
// an answer.
function createPost({ fetchImpl, timeoutMs }) {
  return async function post(url, headers, body) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { response };
    } catch (error) {
      return {
        response: null,
        failure: {
          ok: false,
          outcome: classifyTransportError(error),
          errorCode: transportErrorCode(error),
        },
      };
    }
  };
}

module.exports = { isPlainObject, readJson, formBody, createPost };
