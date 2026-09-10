const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const catalogModulePath = require.resolve("../../src/helpers/xaiCatalog.js");
const originalLoad = Module._load;

function loadCatalog(fetchImpl) {
  delete require.cache[catalogModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { warn() {} };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require(catalogModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function okResponse(models) {
  return { ok: true, status: 200, json: async () => ({ models }) };
}

const CHAT_MODEL = {
  id: "grok-4.6",
  created: 200,
  object: "model",
  owned_by: "xai",
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  context_length: 500000,
};

test("keeps text language models and drops imagine/voice/latest", async () => {
  const { getXaiLanguageModels } = loadCatalog(async () =>
    okResponse([
      CHAT_MODEL,
      { id: "latest", output_modalities: ["text"], created: 300 },
      { id: "grok-imagine-image", output_modalities: ["image"], created: 250 },
      {
        id: "grok-voice-think-fast-2.0",
        output_modalities: ["text"],
        created: 240,
      },
      { id: "grok-stt", output_modalities: ["text"], created: 230 },
    ])
  );

  assert.deepEqual(
    await getXaiLanguageModels({
      getBearer: async () => "oauth-bearer",
      fetchImpl: async () =>
        okResponse([
          CHAT_MODEL,
          { id: "latest", output_modalities: ["text"], created: 300 },
          { id: "grok-imagine-image", output_modalities: ["image"], created: 250 },
          {
            id: "grok-voice-think-fast-2.0",
            output_modalities: ["text"],
            created: 240,
          },
          { id: "grok-stt", output_modalities: ["text"], created: 230 },
        ]),
    }),
    [
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        description: "500k context",
        supportsVision: true,
        supportsThinking: false,
      },
    ]
  );
});

test("sorts newer models first and flags reasoning plus vision", async () => {
  const { parseLanguageModels } = loadCatalog();
  const models = parseLanguageModels({
    models: [
      {
        id: "grok-4.5",
        created: 100,
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      {
        id: "grok-4.20-0309-reasoning",
        created: 150,
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
    ],
  });

  assert.deepEqual(
    models.map((model) => ({
      id: model.id,
      name: model.name,
      supportsThinking: model.supportsThinking,
      supportsVision: model.supportsVision,
    })),
    [
      {
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20 0309 Reasoning",
        supportsThinking: true,
        supportsVision: false,
      },
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        supportsThinking: false,
        supportsVision: false,
      },
    ]
  );
});

test("sends the SuperGrok bearer and shares one in-flight request", async () => {
  let calls = 0;
  const { getXaiLanguageModels } = loadCatalog();
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url, "https://api.x.ai/v1/language-models");
    assert.equal(init.headers.Authorization, "Bearer oauth-bearer");
    return okResponse([CHAT_MODEL]);
  };

  const [first, second] = await Promise.all([
    getXaiLanguageModels({ getBearer: async () => "oauth-bearer", fetchImpl }),
    getXaiLanguageModels({ getBearer: async () => "oauth-bearer", fetchImpl }),
  ]);

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("rejects rather than returning a list when the payload is malformed", async () => {
  const { getXaiLanguageModels } = loadCatalog();
  await assert.rejects(
    getXaiLanguageModels({
      getBearer: async () => "oauth-bearer",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ object: "list" }),
      }),
    }),
    /Malformed models list/
  );
});

test("rejects without a SuperGrok or console bearer", async () => {
  const { getXaiLanguageModels } = loadCatalog();
  await assert.rejects(
    getXaiLanguageModels({ getBearer: async () => "", fetchImpl: async () => okResponse([]) }),
    /credentials not configured/
  );
});

test("backs off after a failure instead of refetching on every call", async () => {
  let calls = 0;
  const { getXaiLanguageModels } = loadCatalog();
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("ENOTFOUND");
  };

  await assert.rejects(
    getXaiLanguageModels({ getBearer: async () => "oauth-bearer", fetchImpl })
  );
  await assert.rejects(
    getXaiLanguageModels({ getBearer: async () => "oauth-bearer", fetchImpl }),
    /unavailable/
  );
  await assert.rejects(
    getXaiLanguageModels({ getBearer: async () => "oauth-bearer", fetchImpl }),
    /unavailable/
  );

  assert.equal(calls, 1);
});
