const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const catalogModulePath = require.resolve("../../src/helpers/opencodeCatalog.js");
const originalLoad = Module._load;

// Each fixture is trimmed from OpenCode's live /models payload (checked
// 2026-11), keeping only the fields the filter and the mapping read.
function loadCatalog() {
  delete require.cache[catalogModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { warn() {}, debug() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(catalogModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function okResponse(data) {
  return { ok: true, status: 200, json: async () => ({ object: "list", data }) };
}

const PAID_PRICE = { text: { input: { price: 1.4 }, output: { price: 4.4 } } };
const FREE_PRICE = { text: { input: { price: 0 }, output: { price: 0 } } };
const CHAT_COMPLETIONS = {
  "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" },
};

const GLM = {
  id: "glm-5.3",
  name: "GLM-5.3",
  description: "Flagship GLM model",
  type: "chat",
  api: CHAT_COMPLETIONS,
  capabilities: { temperature: true, reasoning: { supported: true } },
  cost: PAID_PRICE,
};

const KIMI = {
  ...GLM,
  id: "kimi-k3",
  name: "Kimi K3",
  capabilities: { temperature: false, reasoning: { supported: true, toggle: true } },
};

test("keeps paid chat models that the Chat Completions transport can serve", async () => {
  const { getOpencodeModels } = loadCatalog();
  const models = await getOpencodeModels("opencode-go", {
    fetch: async () =>
      okResponse([
        GLM,
        KIMI,
        { ...GLM, id: "gpt-5.6-luna", api: { responses: {} } },
        { ...GLM, id: "claude-haiku-5-5", api: { messages: {} } },
        { ...GLM, id: "gemini-4-argon", api: { "generate-content": {} } },
        { ...GLM, id: "flux-image", type: "image" },
      ]),
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ["glm-5.3", "kimi-k3"]
  );
});

test("drops free, contributor, zero-priced and deprecated models", async () => {
  const { getOpencodeModels } = loadCatalog();
  const models = await getOpencodeModels("opencode-zen", {
    fetch: async () =>
      okResponse([
        GLM,
        { ...GLM, id: "big-pickle", cost: FREE_PRICE },
        { ...GLM, id: "beam-free" },
        { ...GLM, id: "muse-spark-1.2-contributor" },
        { ...GLM, id: "glm-5", name: "GLM-5" },
        { ...GLM, id: "gpt-5.1-codex", cost: PAID_PRICE },
      ]),
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ["glm-5.3"]
  );
});

test("reads temperature strictly from the live flag", async () => {
  const { getOpencodeModels } = loadCatalog();
  const { capabilities: _unused, ...withoutFlag } = GLM;
  const [glm, kimi, unflagged] = await getOpencodeModels("opencode-go", {
    fetch: async () => okResponse([GLM, KIMI, { ...withoutFlag, id: "unflagged-model" }]),
  });

  assert.equal(glm.supportsTemperature, true);
  assert.equal(kimi.supportsTemperature, false);
  assert.equal(unflagged.supportsTemperature, false);
});

test("offers no thinking toggle, since this transport can't suppress thinking", async () => {
  const { getOpencodeModels } = loadCatalog();
  const [glm] = await getOpencodeModels("opencode-go", { fetch: async () => okResponse([GLM]) });

  assert.equal("supportsThinking" in glm, false);
  assert.equal(glm.tokenParam, "max_tokens");
});

test("shows the id when OpenCode sends a blank display name", async () => {
  const { getOpencodeModels } = loadCatalog();
  const { name: _unused, ...nameless } = GLM;
  const models = await getOpencodeModels("opencode-go", {
    fetch: async () =>
      okResponse([
        { ...GLM, id: "empty-name", name: "" },
        { ...GLM, id: "blank-name", name: "   " },
        { ...nameless, id: "missing-name" },
      ]),
  });

  assert.deepEqual(
    models.map((model) => model.name),
    ["empty-name", "blank-name", "missing-name"]
  );
});

test("keeps the first of two entries sharing an id", async () => {
  const { getOpencodeModels } = loadCatalog();
  const models = await getOpencodeModels("opencode-go", {
    fetch: async () => okResponse([GLM, { ...GLM, name: "Duplicate" }]),
  });

  assert.deepEqual(
    models.map((model) => model.name),
    ["GLM-5.3"]
  );
});

test("sends the configured key only when there is one", async () => {
  const { getOpencodeModels } = loadCatalog();
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return okResponse([GLM]);
  };

  await getOpencodeModels("opencode-go", { apiKey: "sk-go", fetch });
  await getOpencodeModels("opencode-zen", { fetch });

  assert.equal(seen[0].url, "https://opencode.ai/zen/go/v1/models");
  assert.deepEqual(seen[0].headers, { Authorization: "Bearer sk-go" });
  assert.equal(seen[1].url, "https://opencode.ai/zen/v1/models");
  assert.deepEqual(seen[1].headers, {});
});

test("shares one request per product between concurrent callers", async () => {
  const { getOpencodeModels } = loadCatalog();
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return okResponse([GLM]);
  };

  const [first, second, zen] = await Promise.all([
    getOpencodeModels("opencode-go", { fetch }),
    getOpencodeModels("opencode-go", { fetch }),
    getOpencodeModels("opencode-zen", { fetch }),
  ]);

  assert.equal(urls.length, 2);
  assert.equal(first, second);
  assert.notEqual(first, zen);
});

test("rejects a malformed or empty list rather than returning one", async () => {
  const malformed = loadCatalog();
  await assert.rejects(
    malformed.getOpencodeModels("opencode-go", {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ object: "list" }) }),
    }),
    /Malformed models list/
  );

  const empty = loadCatalog();
  await assert.rejects(
    empty.getOpencodeModels("opencode-zen", {
      fetch: async () => okResponse([{ ...GLM, type: "image" }]),
    }),
    /no chat models/
  );
});

test("rejects on a non-200 response", async () => {
  const { getOpencodeModels } = loadCatalog();
  await assert.rejects(
    getOpencodeModels("opencode-go", {
      apiKey: "bad",
      fetch: async () => ({ ok: false, status: 401 }),
    }),
    /401/
  );
});

test("backs off after a failure instead of refetching on every call", async () => {
  const { getOpencodeModels } = loadCatalog();
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    throw new Error("ENOTFOUND");
  };

  await assert.rejects(getOpencodeModels("opencode-go", { fetch }));
  await assert.rejects(getOpencodeModels("opencode-go", { fetch }), /unavailable/);
  await assert.rejects(getOpencodeModels("opencode-go", { fetch }), /unavailable/);

  assert.equal(calls, 1);
});

test("refuses an unknown provider before any request", async () => {
  const { getOpencodeModels } = loadCatalog();
  let calls = 0;
  await assert.rejects(
    getOpencodeModels("opencode", {
      fetch: async () => {
        calls += 1;
        return okResponse([GLM]);
      },
    }),
    /Unsupported OpenCode provider/
  );
  assert.equal(calls, 0);
});
