const { captureAuthFence } = require("./cloudApiRequest");
const { createPolicyResponseError } = require("./policyResponseError");

const {
  ORUKEET_BASE_URL,
  ORUKEET_MODEL,
  ORUKEET_PCM_PROTOCOL,
  ORUKEET_PIPELINE_PROTOCOL,
  ORUKEET_CLEANUP_VARIANT,
  ORUKEET_CLEANUP_MODEL,
  ORUKEET_SESSION_PATH,
  ORUKEET_PIPELINE_SESSION_PATH,
  ORUKEET_PIPELINE_USAGE_PATH,
  ORUKEET_LANGUAGE_PREVIEW_URL,
  ORUKEET_PIPELINE_BASES,
  isOrukeetClientToken,
} = require("./orukeetProtocol");

function validateSession(data, pipeline = false) {
  if (pipeline) {
    if (
      !ORUKEET_PIPELINE_BASES.includes(data?.baseUrl) ||
      data?.websocketUrl !== `${data.baseUrl.replace("https:", "wss:")}/v1/pipeline/stream` ||
      data.protocol !== ORUKEET_PIPELINE_PROTOCOL ||
      data.model !== ORUKEET_MODEL ||
      data.cleanup !== true ||
      data.cleanupModel !== ORUKEET_CLEANUP_MODEL ||
      data.requireAccountLimits !== true ||
      data.singleUse !== true ||
      data.expiresIn !== 60 ||
      !isOrukeetClientToken(data.clientToken, true)
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
    data?.protocol !== ORUKEET_PCM_PROTOCOL ||
    data?.model !== ORUKEET_MODEL ||
    data?.singleUse !== true ||
    data?.expiresIn !== 60 ||
    !isOrukeetClientToken(data?.clientToken)
  ) {
    throw new Error("Invalid Orukeet cloud session");
  }
  return { baseUrl: data.baseUrl, clientToken: data.clientToken };
}

const CLEANUP_USAGE_ATTEMPTS = 3;

async function relayCleanupUsage({
  receipt,
  fence,
  apiUrl,
  proxyFetch,
  withPolicyHeaders,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let attempt = 0; attempt < CLEANUP_USAGE_ATTEMPTS; attempt++) {
    fence.assertCurrent();
    try {
      const usage = await fence.awaitBound(() =>
        proxyFetch(`${apiUrl}${ORUKEET_PIPELINE_USAGE_PATH}`, {
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
      throw Object.assign(new Error("Cleanup usage rejected"), {
        status: usage.status,
        permanent: usage.status < 500 && ![401, 408, 429].includes(usage.status),
      });
    } catch (error) {
      // Never relay the receipt under a replacement account, even between retries.
      fence.assertCurrent();
      if (error.permanent || attempt === CLEANUP_USAGE_ATTEMPTS - 1) throw error;
    }
    await wait(250 * 2 ** attempt);
  }
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
    const mintSession = (options) =>
      fence.awaitBound(() =>
        proxyFetch(`${apiUrl}${options ? ORUKEET_PIPELINE_SESSION_PATH : ORUKEET_SESSION_PATH}`, {
          method: "POST",
          headers: withPolicyHeaders({
            Authorization: fence.authorization,
            ...(options ? { "Content-Type": "application/json" } : {}),
          }),
          ...(options
            ? {
                body: JSON.stringify({
                  variant: ORUKEET_CLEANUP_VARIANT,
                  cleanup: true,
                  cleanupOptions: options,
                }),
              }
            : {}),
          useSessionCookies: false,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        })
      );
    let options = pipelineOptions;
    let response = await mintSession(options);
    assertActive();
    // The ASR permission is independent of Cloud AI. A stale policy or an
    // over-size cleanup prompt must not discard an otherwise valid dictation.
    if (options && !response.ok) {
      const payload = await fence.awaitBound(() =>
        response
          .clone()
          .json()
          .catch(() => null)
      );
      if (
        (response.status === 403 && payload?.code === "POLICY_MODE_BLOCKED") ||
        (response.status === 400 && payload?.code === "PIPELINE_OPTIONS_UNSUPPORTED")
      ) {
        options = undefined;
        response = await mintSession();
        assertActive();
      }
    }
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
    if (options) {
      streaming.cleanupOptions = options;
      streaming.onUsageReceipt = (receipt) => {
        // Completed model work is recorded independently of text delivery.
        streaming.usagePromise = relayCleanupUsage({
          receipt,
          fence,
          apiUrl,
          proxyFetch,
          withPolicyHeaders,
        });
        streaming.usagePromise.catch((error) =>
          streaming.onUsageError?.({ status: error.status, code: error.code })
        );
      };
    }
    await streaming.connect(validateSession(data, Boolean(options)));
    assertActive();
  } catch (error) {
    streaming.close();
    throw error;
  }
}

module.exports = {
  relayCleanupUsage,
  connectManagedOrukeet,
  validateSession,
  ORUKEET_BASE_URL,
  ORUKEET_SESSION_PATH,
};
