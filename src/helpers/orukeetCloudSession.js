const { captureAuthFence } = require("./cloudApiRequest");
const { createPolicyResponseError } = require("./policyResponseError");

const ORUKEET_BASE_URL = "https://orukeet.gizmovoice.ai";
const ORUKEET_SESSION_PATH = "/api/stt/orukeet/session";

function validateSession(data) {
  if (
    data?.baseUrl !== ORUKEET_BASE_URL ||
    data?.websocketUrl !==
      `${ORUKEET_BASE_URL.replace("https:", "wss:")}/v1/audio/transcriptions/stream` ||
    data?.protocol !== "orukeet.pcm.v1" ||
    data?.model !== "orukeet-v0.1.0" ||
    data?.singleUse !== true ||
    data?.expiresIn !== 60 ||
    typeof data?.clientToken !== "string" ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(data.clientToken)
  ) {
    throw new Error("Invalid Orukeet cloud session");
  }
  return { baseUrl: ORUKEET_BASE_URL, clientToken: data.clientToken };
}

// Main process only. The account bearer goes to the existing Cloud backend;
// only its single-use session token goes to the fixed Orukeet endpoint.
async function connectManagedOrukeet({
  streaming,
  getApiUrl,
  proxyFetch,
  tokenStore,
  withPolicyHeaders,
}) {
  const apiUrl = getApiUrl();
  if (!apiUrl) throw new Error("OpenWhispr API URL not configured");
  const fence = captureAuthFence(tokenStore, tokenStore.getState().generation);
  const controller = new AbortController();
  const unsubscribe = tokenStore.subscribe(() => {
    try {
      fence.assertCurrent();
    } catch (error) {
      streaming.fail(error);
    }
  });
  const onClose = streaming.onClose;
  streaming.onClose = () => {
    controller.abort();
    unsubscribe();
    onClose?.();
  };
  const assertActive = () => {
    fence.assertCurrent();
    if (streaming.intentionalClose || streaming.failure) {
      throw streaming.failure || new Error("Orukeet recording cancelled");
    }
  };
  try {
    assertActive();
    const response = await fence.awaitBound(() =>
      proxyFetch(`${apiUrl}${ORUKEET_SESSION_PATH}`, {
        method: "POST",
        headers: withPolicyHeaders({ Authorization: fence.authorization }),
        useSessionCookies: false,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      })
    );
    assertActive();
    if (response.status === 401) {
      throw Object.assign(new Error("Session expired"), { code: "AUTH_EXPIRED", status: 401 });
    }
    if (!response.ok) {
      const payload = await fence.awaitBound(() => response.json().catch(() => null));
      // The weekly word quota, as opposed to the RATE_LIMITED mint cap: the
      // same LIMIT_REACHED the batch upload raises, carrying the usage the
      // upgrade prompt shows.
      if (response.status === 429 && payload?.limitReached === true) {
        throw Object.assign(new Error(payload.error || "Weekly word limit reached"), {
          code: "LIMIT_REACHED",
          status: 429,
          details: { wordsUsed: payload.wordsUsed, limit: payload.limit },
        });
      }
      throw createPolicyResponseError(
        response.status,
        payload,
        `Orukeet session unavailable (${response.status})`
      );
    }
    const data = await fence.awaitBound(() => response.json());
    assertActive();
    await streaming.connect(validateSession(data));
    assertActive();
  } catch (error) {
    streaming.close();
    throw error;
  }
}

module.exports = { connectManagedOrukeet, validateSession, ORUKEET_BASE_URL, ORUKEET_SESSION_PATH };
