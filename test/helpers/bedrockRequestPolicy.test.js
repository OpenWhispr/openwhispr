const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapEnterpriseError,
  runBedrockRequest,
  unwrapRetryError,
} = require("../../src/helpers/enterpriseProviderErrors");

const SERVICE_UNAVAILABLE_MESSAGE =
  "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an OpenWhispr outage. Please try again in a few minutes.";
const THROTTLED_MESSAGE =
  "AWS Bedrock is temporarily limiting requests because it is receiving too many. Please wait a moment and try again. If this continues, ask your AWS administrator to check your Bedrock usage and quotas.";
const TIMEOUT_MESSAGE =
  "AWS Bedrock did not respond in time. Please try again. If this continues, check your internet connection and AWS Bedrock service status.";
const NETWORK_MESSAGE =
  "AWS Bedrock could not be reached. Check your internet connection and try again.";

function awsError({ name, status, message = name, requestId = "request-123", code }) {
  return Object.assign(new Error(message), {
    name,
    ...(code ? { code } : {}),
    $metadata: {
      ...(status ? { httpStatusCode: status } : {}),
      requestId,
    },
  });
}

function deterministicRetryOptions() {
  const delays = [];
  return {
    delays,
    options: {
      initialDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 0.5,
      sleep: async (delay) => delays.push(delay),
    },
  };
}

test("Bedrock cleanup succeeds after a retryable 503", async () => {
  const { delays, options } = deterministicRetryOptions();
  let attempts = 0;

  const result = await runBedrockRequest(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw awsError({
        name: "ServiceUnavailableException",
        status: 503,
        message: "Service unavailable",
      });
    }
    return "cleaned text";
  }, options);

  assert.equal(result, "cleaned text");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [50]);
});

test("Bedrock cleanup aborts during retry backoff without another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let releaseSleep;
  const sleeping = new Promise((resolve) => (releaseSleep = resolve));
  const request = runBedrockRequest(
    async () => {
      attempts += 1;
      throw awsError({ name: "ServiceUnavailableException", status: 503 });
    },
    {
      signal: controller.signal,
      random: () => 0.5,
      sleep: async (_delay, signal) => {
        releaseSleep();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }
  );

  await sleeping;
  controller.abort();
  await assert.rejects(request, (error) => error?.name === "AbortError");
  assert.equal(attempts, 1);
});

test("Bedrock stops after six total attempts when 503 responses continue", async () => {
  const { delays, options } = deterministicRetryOptions();
  let attempts = 0;

  await assert.rejects(
    runBedrockRequest(async () => {
      attempts += 1;
      throw awsError({
        name: "ServiceUnavailableException",
        status: 503,
        message: "Still overloaded",
        requestId: `request-${attempts}`,
      });
    }, options),
    (error) => error.$metadata.requestId === "request-6"
  );

  assert.equal(attempts, 6);
  assert.deepEqual(delays, [50, 100, 200, 400, 800]);
  assert.equal(
    mapEnterpriseError("bedrock", awsError({ name: "ServiceUnavailableException", status: 503 }))
      .message,
    SERVICE_UNAVAILABLE_MESSAGE
  );
});

test("Bedrock retries 429 throttling and returns the quota-specific message", async () => {
  const { options } = deterministicRetryOptions();
  let attempts = 0;
  const throttled = awsError({
    name: "ThrottlingException",
    status: 429,
    message: "Too many requests",
  });

  const result = await runBedrockRequest(async () => {
    attempts += 1;
    if (attempts === 1) throw throttled;
    return "ok";
  }, options);

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.equal(mapEnterpriseError("bedrock", throttled).message, THROTTLED_MESSAGE);
});

test("Bedrock retries a request timeout and returns the timeout message", async () => {
  const { options } = deterministicRetryOptions();
  let attempts = 0;
  const timeout = awsError({ name: "TimeoutError", message: "socket timed out" });

  const result = await runBedrockRequest(async () => {
    attempts += 1;
    if (attempts === 1) throw timeout;
    return "ok";
  }, options);

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.equal(mapEnterpriseError("bedrock", timeout).message, TIMEOUT_MESSAGE);
});

test("Bedrock retries audited network and Undici timeout cause shapes", async () => {
  for (const [code, expectedMessage] of [
    ["ENETDOWN", NETWORK_MESSAGE],
    ["EHOSTDOWN", NETWORK_MESSAGE],
    ["UND_ERR_HEADERS_TIMEOUT", TIMEOUT_MESSAGE],
    ["UND_ERR_BODY_TIMEOUT", TIMEOUT_MESSAGE],
  ]) {
    const transportError = Object.assign(new Error(`transport failed: ${code}`), { code });
    const apiCallError = Object.assign(new Error("Failed to call AWS Bedrock"), {
      name: "AI_APICallError",
      cause: transportError,
    });
    const { options } = deterministicRetryOptions();
    let attempts = 0;

    const result = await runBedrockRequest(async () => {
      attempts += 1;
      if (attempts === 1) throw apiCallError;
      return "ok";
    }, options);

    assert.equal(result, "ok", code);
    assert.equal(attempts, 2, code);
    assert.equal(mapEnterpriseError("bedrock", apiCallError).message, expectedMessage, code);
  }
});

test("Bedrock does not retry access denied errors", async () => {
  const { options } = deterministicRetryOptions();
  let attempts = 0;
  const denied = awsError({
    name: "AccessDeniedException",
    status: 403,
    message: "User is not authorized to perform bedrock:InvokeModel",
  });

  await assert.rejects(
    runBedrockRequest(async () => {
      attempts += 1;
      throw denied;
    }, options),
    denied
  );

  assert.equal(attempts, 1);
  assert.match(
    mapEnterpriseError("bedrock", denied, { bedrockRegion: "eu-west-1" }).message,
    /permission/i
  );
});

test("Bedrock keeps rejected authentication distinct from permission errors", () => {
  const invalidToken = awsError({
    name: "InvalidClientTokenId",
    status: 403,
    message: "The security token included in the request is invalid",
  });

  assert.match(mapEnterpriseError("bedrock", invalidToken).message, /credentials were rejected/i);
});

test("Bedrock normalizes AI SDK exception identity from headers and parsed data", () => {
  for (const scenario of [
    {
      label: "case-insensitive response header",
      error: Object.assign(new Error("The security token is invalid"), {
        name: "AI_APICallError",
        statusCode: 403,
        responseHeaders: {
          "X-AmZn-ErRoRtYpE": "com.amazon.identity#InvalidClientTokenId:client",
        },
      }),
      expectedMessage: /credentials were rejected/i,
      expectedExceptionType: "InvalidClientTokenId",
    },
    {
      label: "parsed data code",
      error: Object.assign(new Error("The security token is invalid"), {
        name: "AI_APICallError",
        statusCode: 403,
        data: { code: "InvalidClientTokenId:client" },
      }),
      expectedMessage: /credentials were rejected/i,
      expectedExceptionType: "InvalidClientTokenId",
    },
    {
      label: "parsed data __type",
      error: Object.assign(new Error("The requested model was not found"), {
        name: "AI_APICallError",
        statusCode: 404,
        data: { __type: "com.amazon.bedrock#ResourceNotFoundException" },
      }),
      expectedMessage: /could not find the selected model/i,
      expectedExceptionType: "ResourceNotFoundException",
    },
  ]) {
    const mapped = mapEnterpriseError("bedrock", scenario.error, {
      bedrockRegion: "us-west-2",
    });
    assert.match(mapped.message, scenario.expectedMessage, scenario.label);
    assert.equal(
      mapped.technicalDetails.exceptionType,
      scenario.expectedExceptionType,
      scenario.label
    );
  }
});

test("Bedrock does not retry invalid model or configuration errors", async () => {
  const { options } = deterministicRetryOptions();

  for (const error of [
    awsError({
      name: "ValidationException",
      status: 400,
      message: "The provided model identifier is invalid",
    }),
    Object.assign(new Error("Region is missing"), { name: "CredentialsProviderError" }),
  ]) {
    let attempts = 0;
    await assert.rejects(
      runBedrockRequest(async () => {
        attempts += 1;
        throw error;
      }, options),
      error
    );
    assert.equal(attempts, 1);
  }

  assert.match(
    mapEnterpriseError("bedrock", awsError({ name: "ValidationException", status: 400 }), {
      bedrockRegion: "eu-west-1",
    }).message,
    /model.*configuration.*eu-west-1/i
  );
});

test("RetryError.lastError is unwrapped before classification and diagnostics", () => {
  const underlying = awsError({
    name: "ServiceUnavailableException",
    status: 503,
    message: "Bedrock overloaded in eu-west-1",
    requestId: "aws-request-underlying",
  });
  const wrapped = Object.assign(new Error("Failed after 3 attempts"), {
    name: "AI_RetryError",
    lastError: underlying,
  });

  assert.equal(unwrapRetryError(wrapped), underlying);
  const mapped = mapEnterpriseError("bedrock", wrapped);
  assert.equal(mapped.message, SERVICE_UNAVAILABLE_MESSAGE);
  assert.deepEqual(mapped.technicalDetails, {
    status: 503,
    exceptionType: "ServiceUnavailableException",
    requestId: "aws-request-underlying",
    underlyingError: "Bedrock overloaded in eu-west-1",
  });
});

test("Bedrock mappings include renderer localization metadata", () => {
  const unavailable = mapEnterpriseError(
    "bedrock",
    awsError({ name: "ServiceUnavailableException", status: 503 })
  );
  assert.equal(
    unavailable.messageKey,
    "reasoning.enterprise.errors.bedrock.serviceUnavailable"
  );

  const denied = mapEnterpriseError(
    "bedrock",
    awsError({ name: "AccessDeniedException", status: 403 }),
    { bedrockRegion: "eu-west-1" }
  );
  assert.equal(denied.messageKey, "reasoning.enterprise.errors.bedrock.accessDenied");
  assert.deepEqual(denied.messageParams, { region: "eu-west-1" });

  const expired = mapEnterpriseError(
    "bedrock",
    awsError({ name: "ExpiredTokenException", status: 403 }),
    { bedrockProfile: "company-sso" }
  );
  assert.equal(expired.messageKey, "reasoning.enterprise.errors.bedrock.ssoExpired");
  assert.equal(expired.actionKey, "reasoning.enterprise.errors.bedrock.actions.reauthenticate");
  assert.equal(expired.copyCommand, "aws sso login --profile company-sso");
});
