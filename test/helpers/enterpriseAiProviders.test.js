const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getEnterpriseAIModel,
  toAzureOpenAIBaseUrl,
} = require("../../src/helpers/enterpriseAiProviders.js");

test("builds the Azure SDK base below the public resource origin", () => {
  assert.equal(
    toAzureOpenAIBaseUrl("https://example.openai.azure.com"),
    "https://example.openai.azure.com/openai"
  );
  assert.equal(
    toAzureOpenAIBaseUrl("https://example.openai.azure.com/"),
    "https://example.openai.azure.com/openai"
  );
});

test("rejects unsupported managed Azure endpoint forms", () => {
  for (const endpoint of [
    "https://example.services.ai.azure.com",
    "https://example.openai.azure.us",
    "https://example.openai.azure.com/openai",
    "https://example.openai.azure.com?api-key=secret",
  ]) {
    assert.throws(() => toAzureOpenAIBaseUrl(endpoint), /public Azure resource origin/);
  }
});

test("managed Bedrock credential failures preserve the original AWS error", async () => {
  const cause = Object.assign(new Error("credential exchange failed"), {
    code: "ECONNRESET",
  });
  const credentialError = Object.assign(new Error("temporary credentials expired"), {
    name: "ExpiredTokenException",
    $metadata: {
      httpStatusCode: 403,
      requestId: "credential-request-123",
    },
    cause,
  });

  await assert.rejects(
    getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
      bedrockRegion: "us-west-2",
      managedCredentialProvider: async () => {
        throw credentialError;
      },
    }),
    (error) => error === credentialError
  );
});

test("managed Bedrock credentials are resolved once before the real SDK reaches fetch", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
    };
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  let credentialCalls = 0;
  const model = await getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
    bedrockRegion: "us-west-2",
    managedCredentialProvider: async () => {
      credentialCalls += 1;
      return {
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "example-secret",
        sessionToken: "example-session-token",
      };
    },
  });

  assert.equal(credentialCalls, 1);
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(credentialCalls, 1);
  assert.match(request.url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\//);
  assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(request.headers["x-amz-security-token"], "example-session-token");
});

test("explicit Bedrock credential sources cannot fall through to populated AWS environment", async (t) => {
  const environmentKeys = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ];
  const originalEnvironment = new Map(
    environmentKeys.map((key) => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(process.env, key),
        value: process.env[key],
      },
    ])
  );
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  process.env.AWS_ACCESS_KEY_ID = "AKIAENVIRONMENT";
  process.env.AWS_SECRET_ACCESS_KEY = "environment-secret";
  process.env.AWS_SESSION_TOKEN = "environment-session-token";
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, original] of originalEnvironment) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
  });

  for (const [label, enterprise] of [
    ["null managed result", { managedCredentialProvider: async () => null }],
    [
      "missing managed access key",
      { managedCredentialProvider: async () => ({ secretAccessKey: "managed-secret" }) },
    ],
    [
      "missing managed secret",
      { managedCredentialProvider: async () => ({ accessKeyId: "AKIAMANAGED" }) },
    ],
    ["partial manual static keys", { bedrockAccessKeyId: "AKIAEXPLICIT" }],
  ]) {
    await assert.rejects(
      getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
        bedrockRegion: "us-west-2",
        ...enterprise,
      }),
      (error) =>
        error?.name === "CredentialsProviderError" &&
        /accessKeyId and secretAccessKey/.test(error.message),
      label
    );
  }
  assert.equal(fetchCalls, 0);
});

test("Bedrock environment fallback remains available without an explicit credential source", async (t) => {
  const environmentKeys = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ];
  const originalEnvironment = new Map(
    environmentKeys.map((key) => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(process.env, key),
        value: process.env[key],
      },
    ])
  );
  const originalFetch = global.fetch;
  let request;
  process.env.AWS_ACCESS_KEY_ID = "AKIAENVIRONMENT";
  process.env.AWS_SECRET_ACCESS_KEY = "environment-secret";
  process.env.AWS_SESSION_TOKEN = "environment-session-token";
  global.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
    };
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, original] of originalEnvironment) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
  });

  const model = await getEnterpriseAIModel("bedrock", "anthropic.claude-haiku", "", {
    bedrockRegion: "us-west-2",
  });
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );

  assert.match(request.url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\//);
  assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(request.headers["x-amz-security-token"], "environment-session-token");
});

test("the pinned Azure SDK requests the deployment below /openai/v1 with bearer auth", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: JSON.parse(init.body),
    };
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const model = await getEnterpriseAIModel("azure", "deployment-a", "", {
    azureEndpoint: "https://example.openai.azure.com",
    azureApiVersion: "v1",
    managedTokenProvider: async () => "temporary-bearer-token",
  });
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(
    request.url,
    "https://example.openai.azure.com/openai/v1/responses?api-version=v1"
  );
  assert.equal(request.headers.authorization, "Bearer temporary-bearer-token");
  assert.equal(request.body.model, "deployment-a");
});

test("manual Azure setup preserves legacy endpoints and API-key auth", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
    };
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const model = await getEnterpriseAIModel("azure", "legacy-deployment", "legacy-api-key", {
    azureEndpoint: "https://legacy.example.com/custom/openai",
    azureApiVersion: "2024-10-21",
  });
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(
    request.url,
    "https://legacy.example.com/custom/openai/responses"
  );
  assert.equal(request.headers["api-key"], "legacy-api-key");
});
