const { captureAuthFence } = require("./cloudApiRequest");
const { createPolicyResponseError } = require("./policyResponseError");

const ORUKEET_BASE_URL = "https://orukeet.gizmovoice.ai";
const ORUKEET_LANGUAGE_PREVIEW_URL = `${ORUKEET_BASE_URL}/preview/language-routing`;
const ORUKEET_SESSION_PATH = "/api/stt/orukeet/session";

function validateSession(data, pipeline = false) {
  if (pipeline) {
    const bases = [
      "preview",
      "regions/us-west1",
      "regions/europe-west4",
      "regions/asia-southeast1",
    ].map((path) => `${ORUKEET_BASE_URL}/${path}/gemma12`);
    if (
      !bases.includes(data?.baseUrl) ||
      data?.websocketUrl !== `${data.baseUrl.replace("https:", "wss:")}/v1/pipeline/stream` ||
      data.protocol !== "orukeet.pipeline.v2" ||
      data.model !== "orukeet-v0.1.0" ||
      data.cleanup !== true ||
      data.cleanupModel !== "gemma-4-12b" ||
      data.requireAccountLimits !== true ||
      data.singleUse !== true ||
      data.expiresIn !== 60 ||
      typeof data.clientToken !== "string" ||
      !/^[A-Za-z0-9._-]{1,160}$/.test(data.clientToken)
    )
      throw new Error("Invalid Orukeet pipeline session");
    return {
      baseUrl: data.baseUrl,
      clientToken: data.clientToken,
      protocol: data.protocol,
      requireAccountLimits: true,
    };
  }
  if (
    ![ORUKEET_BASE_URL, ORUKEET_LANGUAGE_PREVIEW_URL].includes(data?.baseUrl) ||
    data?.websocketUrl !==
      `${data?.baseUrl?.replace("https:", "wss:")}/v1/audio/transcriptions/stream` ||
    data?.protocol !== "orukeet.pcm.v1" ||
    data?.model !== "orukeet-v0.1.0" ||
    data?.singleUse !== true ||
    data?.expiresIn !== 60 ||
    typeof data?.clientToken !== "string" ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(data.clientToken)
  ) {
    throw new Error("Invalid Orukeet cloud session");
  }
  return { baseUrl: data.baseUrl, clientToken: data.clientToken };
}

// Main process only. The account bearer goes to the existing Cloud backend;
// only its single-use session token goes to the fixed Orukeet endpoint.
async function connectManagedOrukeet({
  streaming,
  getApiUrl,
  proxyFetch,
  tokenStore,
  withPolicyHeaders,
  pipelineOptions,
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
      proxyFetch(
        `${apiUrl}${pipelineOptions ? "/api/stt/orukeet/pipeline-session" : ORUKEET_SESSION_PATH}`,
        {
          method: "POST",
          headers: withPolicyHeaders({
            Authorization: fence.authorization,
            ...(pipelineOptions ? { "Content-Type": "application/json" } : {}),
          }),
          ...(pipelineOptions
            ? {
                body: JSON.stringify({
                  variant: "gemma12",
                  cleanup: true,
                  cleanupOptions: pipelineOptions,
                }),
              }
            : {}),
          useSessionCookies: false,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        }
      )
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
    if (pipelineOptions) {
      streaming.cleanupOptions = pipelineOptions;
      streaming.onUsageReceipt = (receipt) => {
        // Meter completed model work even if later language/agent routing discards
        // its text. This never delays paste and never carries the service key.
        streaming.usagePromise = (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            fence.assertCurrent();
            try {
              const usage = await fence.awaitBound(() =>
                proxyFetch(`${apiUrl}/api/stt/orukeet/pipeline-usage`, {
                  method: "POST",
                  headers: withPolicyHeaders({
                    Authorization: fence.authorization,
                    "Content-Type": "application/json",
                  }),
                  body: JSON.stringify({ receipt }),
                  useSessionCookies: false,
                  redirect: "error",
                  cache: "no-store",
                  signal: AbortSignal.timeout(10000),
                })
              );
              if (usage.ok) return;
              if (usage.status < 500)
                throw Object.assign(new Error("Cleanup usage rejected"), { permanent: true });
            } catch (error) {
              if (error.permanent || attempt === 2) throw error;
            }
            if (attempt < 2)
              await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
          throw new Error("Cleanup usage unavailable");
        })();
        streaming.usagePromise.catch(() => streaming.onUsageError?.());
      };
    }
    await streaming.connect(validateSession(data, Boolean(pipelineOptions)));
    assertActive();
  } catch (error) {
    streaming.close();
    throw error;
  }
}

module.exports = { connectManagedOrukeet, validateSession, ORUKEET_BASE_URL, ORUKEET_SESSION_PATH };
