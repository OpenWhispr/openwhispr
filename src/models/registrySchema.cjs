const { z } = require("zod");
const { createHash } = require("node:crypto");
const { selectCatalogForVersion, isRegistryVersion } = require("./registrySelection.js");

const SCHEMA_VERSION = 2;
const text = z.string().min(1).max(4096);
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)
  .refine(
    (value) =>
      !/^[A-Za-z]:/.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Unsafe model ID path"
  );
const version = z.string().refine(isRegistryVersion, "Invalid semantic version");
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().positive().finite();
const safeName = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !/^temp-extract-/i.test(value) &&
      !/\.(tmp|tar\.bz2)$/i.test(value) &&
      !value.endsWith(".") &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
const ggufName = safeName.refine((value) => /\.gguf$/i.test(value), "GGUF files end in .gguf");
const whisperName = safeName.refine(
  (value) => /^ggml-[A-Za-z0-9._-]+\.bin$/.test(value),
  "Whisper files are named ggml-*.bin"
);
const hfRepo = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => !value.includes(".."));

function isModelUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      /[\\\s%]/.test(value) ||
      value.split("/").some((part) => part === "." || part === "..")
    )
      return false;
    if (url.hostname === "huggingface.co")
      return /^\/[^/]+\/[^/]+\/resolve\/[^/]+\/.+/.test(url.pathname);
    return (
      url.hostname === "github.com" &&
      /^\/(k2-fsa|ggml-org|OpenWhispr)\/[^/]+\/releases\/download\/[^/]+\/.+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
const isPinnedUrl = (value) =>
  /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//.test(value);
const modelUrl = z.string().max(2048).refine(isModelUrl, "Unsupported model download URL");
const archiveUrl = modelUrl.refine((value) => value.endsWith(".tar.bz2"), "Archives end in .tar.bz2");

// Lifecycle (both flags optional): legacy still works but is hidden unless selected or
// downloaded; retired no longer works and moves selections to its replacement.
const lifecycle = {
  name: text,
  description: text,
  descriptionKey: text.optional(),
  minAppVersion: version.optional(),
  legacy: z.boolean().optional(),
  retired: z.boolean().optional(),
  replacement: id.optional(),
};
const effortLevel = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
// Nested objects are built per reading (see buildSchemas) so they follow the same
// strict-to-write, lenient-to-read split as the entries that hold them.
const reasoningEffortShape = {
  options: z.array(effortLevel).min(1).max(10),
  defaultValue: effortLevel.optional(),
};
const thinkingLevelShape = { level: z.enum(["minimal", "low"]) };
const thinkingBudgetShape = { budget: z.number().int().min(0).max(1000000) };
const organizationShape = { id: z.enum(["oruk", "nvidia", "cohere"]), name: text };
const cloudModel = {
  ...lifecycle,
  id,
  disableThinking: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  tokenParam: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  supportsTemperature: z.boolean().optional(),
};
const transcriptionModel = { ...lifecycle, id, streaming: z.boolean().optional() };
const localModel = {
  ...lifecycle,
  id,
  size: text,
  sizeBytes: positive,
  fileName: ggufName,
  quantization: text,
  contextLength: z.number().int().positive().max(10000000),
  hfRepo,
  revision: revision.optional(),
  recommended: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  sha256: sha256.optional(),
  draftHfRepo: hfRepo.optional(),
  draftRevision: revision.optional(),
  draftFileName: ggufName.optional(),
  draftSizeBytes: positive.optional(),
  draftSha256: sha256.optional(),
};
const completeDraft = (model) => {
  const draft = [model.draftHfRepo, model.draftFileName, model.draftSizeBytes];
  return draft.every((value) => value === undefined)
    ? model.draftSha256 === undefined && model.draftRevision === undefined
    : draft.every((value) => value !== undefined);
};
const whisperModel = {
  ...lifecycle,
  size: text,
  sizeMb: positive,
  expectedSizeBytes: positive.optional(),
  fileName: whisperName,
  downloadUrl: modelUrl,
  recommended: z.boolean().optional(),
  sha256: sha256.optional(),
};
const parakeetModel = {
  ...lifecycle,
  size: text,
  sizeMb: positive,
  expectedSizeBytes: positive.optional(),
  language: text,
  supportedLanguages: z.array(z.string().min(1).max(20)).max(1000),
  downloadUrl: archiveUrl,
  extractDir: safeName,
  manifestUrl: modelUrl.optional(),
  runtime: z.enum(["offline", "online"]).optional(),
  modelType: z.enum(["transducer", "cohere-transcribe"]).optional(),
  sherpaModelType: z.literal("nemo_transducer").optional(),
  recommended: z.boolean().optional(),
  sha256: sha256.optional(),
  license: text.optional(),
  modelCardUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://huggingface.co/"))
    .optional(),
};
const providerShape = (extra, model) => ({
  id: safeName,
  name: text,
  defaultModel: id.optional(),
  ...extra,
  models: z.array(model).max(1000),
});

// One definition, two readings. Authoring (registry CI) rejects unknown keys so typos
// fail review; reading (the app) drops them, so a field added later never makes an
// older app reject the catalog. Dropped keys never reach the app either way.
function buildSchemas(strict) {
  const object = (shape) => (strict ? z.strictObject(shape) : z.object(shape));
  const models = {
    cloud: object({
      ...cloudModel,
      reasoningEffort: object(reasoningEffortShape).optional(),
      thinkingFloor: z.union([object(thinkingLevelShape), object(thinkingBudgetShape)]).optional(),
    }),
    transcription: object(transcriptionModel),
    local: object(localModel).refine(completeDraft, "Incomplete draft artifact"),
    whisper: object(whisperModel),
    parakeet: object({ ...parakeetModel, organization: object(organizationShape).optional() }),
  };
  const providers = {
    cloudProviders: object(providerShape({}, models.cloud)),
    enterpriseProviders: object(
      providerShape({ allowCustomModelId: z.boolean() }, models.cloud)
    ),
    transcriptionProviders: object(
      providerShape({ baseUrl: z.string().url(), batchModel: id.optional() }, models.transcription)
    ),
    localProviders: object(
      providerShape({ baseUrl: z.literal("https://huggingface.co") }, models.local)
    ),
  };
  const maps = { whisperModels: models.whisper, parakeetModels: models.parakeet };
  const catalog = object({
    whisperModels: z.record(safeName, models.whisper),
    parakeetModels: z.record(safeName, models.parakeet),
    ...Object.fromEntries(
      Object.entries(providers).map(([key, schema]) => [key, z.array(schema).max(1000)])
    ),
    // Preserved legacy sections have no runtime consumer. They cannot be edited remotely.
    diarizationModels: z.record(z.string(), z.json()),
    openwhisprCloudModels: z.json(),
  });
  return { models, providers, maps, catalog };
}
const authoring = buildSchemas(true);
const reading = buildSchemas(false);

const PROVIDER_SECTIONS = [
  "cloudProviders",
  "enterpriseProviders",
  "transcriptionProviders",
  "localProviders",
];
const MAP_SECTIONS = ["whisperModels", "parakeetModels"];
const LEGACY_SECTIONS = ["diarizationModels", "openwhisprCloudModels"];
// Fields that change the shape of a provider request. Editing one on a published model
// is allowed but needs a maintainer's explicit acknowledgement (capability-change label).
const CAPABILITY_FIELDS = [
  "tokenParam",
  "supportsTemperature",
  "supportsThinking",
  "disableThinking",
  "supportsVision",
  "supportsTools",
  "reasoningEffort",
  "thinkingFloor",
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isActive = (model) => !model.retired && !model.legacy;
const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

function rejectUnsafeKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    requireCondition(
      !["__proto__", "prototype", "constructor"].includes(key),
      "Unsafe registry property"
    );
    rejectUnsafeKeys(child);
  }
}

function assertLifecycle(model, modelId, label, peers) {
  requireCondition(!(model.retired && model.legacy), `${label} cannot be both legacy and retired`);
  if (model.replacement === undefined) return;
  requireCondition(model.retired === true, `${label} names a replacement but is not retired`);
  const target = peers.get(model.replacement);
  requireCondition(
    model.replacement !== modelId && !!target && isActive(target),
    `${label} replacement must be an active model of the same provider`
  );
}

function validateCatalog(input) {
  rejectUnsafeKeys(input);
  const data = authoring.catalog.parse(input);
  const byId = new Map();
  for (const section of PROVIDER_SECTIONS) {
    const sectionIds = new Map();
    const providers = new Set();
    for (const provider of data[section]) {
      requireCondition(!providers.has(provider.id), `Duplicate provider ${provider.id}`);
      providers.add(provider.id);
      const models = new Map();
      for (const model of provider.models) {
        requireCondition(!models.has(model.id), `Duplicate model ${provider.id}/${model.id}`);
        models.set(model.id, model);
      }
      for (const model of provider.models) {
        const label = `${provider.id}/${model.id}`;
        assertLifecycle(model, model.id, label, models);
        if (model.tokenParam)
          requireCondition(
            model.supportsTemperature !== undefined,
            `${label} sets tokenParam without supportsTemperature`
          );
        // Local and transcription models are found by ID alone (a download, a route), so
        // an ID belongs to one provider. Cloud models are handled below.
        if (section === "localProviders" || section === "transcriptionProviders") {
          requireCondition(
            !sectionIds.has(model.id),
            `Ambiguous model ID ${model.id} in ${sectionIds.get(model.id)} and ${provider.id}`
          );
          sectionIds.set(model.id, provider.id);
        }
        if (section === "cloudProviders" || section === "enterpriseProviders") {
          // The app looks cloud models up by ID alone and takes the first match, so a
          // repeated ID either declares no request settings (it inherits the first
          // entry's) or declares the same ones.
          const other = byId.get(model.id);
          if (other)
            requireCondition(
              CAPABILITY_FIELDS.every((field) => model[field] === undefined) ||
                CAPABILITY_FIELDS.every((field) => same(model[field], other.model[field])),
              `${label} and ${other.label} share an ID but not request settings`
            );
          else byId.set(model.id, { model, label });
        }
      }
      if (provider.models.some(isActive))
        requireCondition(!!provider.defaultModel, `${provider.id} must name its defaultModel`);
      if (provider.defaultModel) {
        const fallback = models.get(provider.defaultModel);
        requireCondition(
          !!fallback && isActive(fallback),
          `${provider.id} default must be an active model of that provider`
        );
      }
    }
  }
  const localFiles = new Set();
  for (const model of data.localProviders.flatMap((provider) => provider.models)) {
    for (const name of [model.fileName, model.draftFileName].filter(Boolean)) {
      const key = name.toLowerCase();
      requireCondition(!localFiles.has(key), `Colliding model artifact filename ${name}`);
      localFiles.add(key);
    }
  }
  const mapIds = new Set();
  for (const section of MAP_SECTIONS) {
    const entries = new Map(Object.entries(data[section]));
    const names = new Set();
    for (const [modelId, model] of entries) {
      const key = modelId.toLowerCase();
      requireCondition(!mapIds.has(key), `Ambiguous local model ID ${modelId}`);
      mapIds.add(key);
      assertLifecycle(model, modelId, `${section}/${modelId}`, entries);
      // Parakeet installs under its model ID (checked above); Whisper under its file name.
      const name = model.fileName?.toLowerCase();
      if (!name) continue;
      requireCondition(!names.has(name), `Colliding ${section} artifact ${name}`);
      names.add(name);
    }
  }
  return data;
}

// Previous publications were valid under the rules of their own day; read them leniently.
function readPrevious(input) {
  return reading.catalog.parse(input);
}

const ARTIFACTS = {
  localProviders: [
    { location: ["hfRepo", "revision"], digest: "sha256", pinned: (m) => !!m.revision },
    {
      location: ["draftHfRepo", "draftRevision"],
      digest: "draftSha256",
      pinned: (m) => !!m.draftRevision,
    },
  ],
  whisperModels: [{ location: ["downloadUrl"], digest: "sha256", pinned: (m) => isPinnedUrl(m.downloadUrl) }],
  parakeetModels: [
    { location: ["downloadUrl"], digest: "sha256", pinned: (m) => isPinnedUrl(m.downloadUrl) },
  ],
};
const IDENTITY_FIELDS = [
  "fileName",
  "draftFileName",
  "extractDir",
  "runtime",
  "modelType",
  "sherpaModelType",
  "organization",
  "quantization",
  "contextLength",
];

// A downloadable file is located by its URL/revision and proven by its hash. Correct one
// leg at a time so the other still vouches for the bytes: move a file while its hash
// stays, or fix a hash while its pinned location stays. Both at once is a different file.
function assertArtifactTransition(next, previous, section, label) {
  for (const field of IDENTITY_FIELDS)
    requireCondition(
      same(next[field], previous[field]),
      `Changed native model identity: ${label} ${field} (use a new model ID)`
    );
  for (const artifact of ARTIFACTS[section]) {
    const moved = artifact.location.some((field) => next[field] !== previous[field]);
    const before = previous[artifact.digest];
    const after = next[artifact.digest];
    requireCondition(!before || !!after, `Removed artifact digest: ${label} ${artifact.digest}`);
    if (moved && before !== after)
      throw new Error(`${label} changed both location and ${artifact.digest}; use a new model ID`);
    if (moved) requireCondition(!!before, `${label} can only move once ${artifact.digest} is set`);
    if (before && after !== before)
      requireCondition(
        artifact.pinned(previous),
        `${label} can only correct ${artifact.digest} at a pinned revision`
      );
    if (moved && section === "localProviders")
      requireCondition(artifact.pinned(next), `${label} must move to a pinned revision`);
  }
  // The download-count manifest is not the model's bytes; it may change, pinned.
  for (const field of ["downloadUrl", "manifestUrl"])
    if (
      next[field] &&
      next[field] !== previous[field] &&
      new URL(next[field]).hostname === "huggingface.co"
    )
      requireCondition(isPinnedUrl(next[field]), `${label} must move to a pinned revision`);
}

function assertNewDownload(model) {
  requireCondition(!!model.sha256, "New model download requires sha256");
  if (model.hfRepo)
    requireCondition(!!model.revision, "New model download requires a pinned revision");
  for (const field of ["downloadUrl", "manifestUrl"]) {
    if (model[field] && new URL(model[field]).hostname === "huggingface.co")
      requireCondition(isPinnedUrl(model[field]), "New model download requires a pinned revision");
  }
  if (model.draftFileName) {
    requireCondition(!!model.draftRevision, "New draft download requires a pinned revision");
    requireCondition(!!model.draftSha256, "New draft download requires draftSha256");
  }
}

function assertModelTransition(next, previous, section, label) {
  requireCondition(!previous.retired || next.retired === true, `${label} cannot be un-retired`);
  requireCondition(
    next.minAppVersion === previous.minAppVersion,
    `${label} changed its published minimum app version`
  );
  if (section === "transcriptionProviders")
    requireCondition(next.streaming === previous.streaming, `${label} changed transcription transport`);
  if (ARTIFACTS[section]) assertArtifactTransition(next, previous, section, label);
}

const engine = (model) => [
  model.runtime || "offline",
  model.modelType || "transducer",
  model.sherpaModelType || "auto",
];

// `floor` is the catalog the shipping app bundles. Its entries were reviewed in the app
// repository, so only downloads that are new to both floor and previous need hashes.
function assertCompatibleCatalog(input, previousInput, { floor } = {}) {
  const next = validateCatalog(input);
  const previous = readPrevious(previousInput);
  const bundled = floor ? readPrevious(floor) : previous;
  for (const section of PROVIDER_SECTIONS) {
    requireCondition(
      same(
        next[section].map((p) => p.id),
        previous[section].map((p) => p.id)
      ),
      `Changed providers in ${section}`
    );
    for (const oldProvider of previous[section]) {
      const provider = next[section].find((item) => item.id === oldProvider.id);
      for (const field of ["baseUrl", "allowCustomModelId", "batchModel"])
        requireCondition(
          provider[field] === oldProvider[field],
          `Changed provider contract ${provider.id}/${field}`
        );
      for (const oldModel of oldProvider.models) {
        const model = provider.models.find((item) => item.id === oldModel.id);
        requireCondition(!!model, `Removed model ${provider.id}/${oldModel.id} (retire it instead)`);
        assertModelTransition(model, oldModel, section, `${provider.id}/${model.id}`);
      }
      const shipped = new Set(
        bundled[section].find((p) => p.id === provider.id)?.models.map((m) => m.id)
      );
      for (const model of provider.models) {
        if (oldProvider.models.some((old) => old.id === model.id)) continue;
        if (section === "transcriptionProviders") {
          requireCondition(
            !["xai", "corti"].includes(provider.id),
            `Transcription adapter ${provider.id} does not support model selection`
          );
          requireCondition(
            !model.streaming || oldProvider.models.some((m) => m.streaming),
            `Unsupported streaming provider ${provider.id}`
          );
          requireCondition(
            model.streaming || oldProvider.models.some((m) => !m.streaming),
            `Unsupported batch provider ${provider.id}`
          );
        }
        if (section === "localProviders" && !shipped.has(model.id)) assertNewDownload(model);
      }
    }
  }
  for (const section of MAP_SECTIONS) {
    for (const [modelId, oldModel] of Object.entries(previous[section])) {
      requireCondition(
        Object.hasOwn(next[section], modelId),
        `Removed model ${modelId} (retire it instead)`
      );
      assertModelTransition(next[section][modelId], oldModel, section, modelId);
    }
    for (const [modelId, model] of Object.entries(next[section])) {
      if (Object.hasOwn(previous[section], modelId)) continue;
      if (section === "parakeetModels")
        requireCondition(
          Object.values(previous.parakeetModels).some((old) => same(engine(old), engine(model))),
          "Unsupported native engine combination"
        );
      if (!Object.hasOwn(bundled[section], modelId)) assertNewDownload(model);
    }
  }
  for (const section of LEGACY_SECTIONS)
    requireCondition(same(next[section], previous[section]), `Changed legacy section ${section}`);
  return next;
}

// Published models whose request settings changed; registry CI requires a maintainer's
// capability-change label before these can merge.
function capabilityChanges(input, previousInput) {
  const next = validateCatalog(input);
  const previous = readPrevious(previousInput);
  const changes = [];
  for (const section of ["cloudProviders", "enterpriseProviders", "localProviders"])
    for (const oldProvider of previous[section]) {
      const provider = next[section].find((item) => item.id === oldProvider.id);
      for (const oldModel of oldProvider.models) {
        const model = provider?.models.find((item) => item.id === oldModel.id);
        const fields = CAPABILITY_FIELDS.filter((field) => model && !same(model[field], oldModel[field]));
        if (fields.length) changes.push({ section, provider: provider.id, id: model.id, fields });
      }
    }
  return changes;
}

function readEntry(schema, value) {
  if (!value || typeof value !== "object") return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function acceptProviders(section, input, bundled) {
  const remote = Array.isArray(input) ? input : [];
  return bundled.map((shipped) => {
    const found = remote.find((item) => item && item.id === shipped.id);
    const models = [];
    const seen = new Set();
    const add = (model) => {
      if (seen.has(model.id)) return;
      seen.add(model.id);
      models.push(model);
    };
    for (const raw of Array.isArray(found?.models) ? found.models : []) {
      const model = readEntry(reading.providers[section].shape.models.element, raw);
      if (model) add(model);
    }
    for (const model of shipped.models) add(structuredClone(model));
    const defaultModel = [found?.defaultModel, shipped.defaultModel].find((candidate) =>
      models.some((model) => model.id === candidate && isActive(model))
    );
    // Provider identity, endpoints and transport come from the app, never from data.
    return { ...structuredClone(shipped), models, defaultModel };
  });
}

function acceptMap(section, input, bundled) {
  const result = {};
  const remote = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const [modelId, raw] of Object.entries(remote)) {
    if (!safeName.safeParse(modelId).success || Object.hasOwn(result, modelId)) continue;
    const model = readEntry(reading.maps[section], raw);
    if (model) result[modelId] = model;
  }
  for (const [modelId, model] of Object.entries(bundled))
    if (!Object.hasOwn(result, modelId)) result[modelId] = structuredClone(model);
  return result;
}

function settleReferences(data) {
  const settle = (models) => {
    for (const model of models.values()) {
      const target = models.get(model.replacement);
      if (model.replacement !== undefined && (!model.retired || !target || !isActive(target)))
        delete model.replacement;
    }
  };
  for (const section of PROVIDER_SECTIONS)
    for (const provider of data[section]) {
      const models = new Map(provider.models.map((model) => [model.id, model]));
      settle(models);
      const fallback = models.get(provider.defaultModel);
      if (!fallback || !isActive(fallback))
        provider.defaultModel = provider.models.find(isActive)?.id;
      if (provider.defaultModel === undefined) delete provider.defaultModel;
    }
  for (const section of MAP_SECTIONS) settle(new Map(Object.entries(data[section])));
  return data;
}

// The app's reader. A signed catalog is applied entry by entry: unknown fields are
// dropped, an entry this app cannot understand is skipped, and the bundled copy stands in
// for anything missing. It never throws on data, so a bad catalog cannot stop the app.
function acceptCatalog(input, bundled, appVersion) {
  try {
    let data;
    try {
      rejectUnsafeKeys(input);
      const remote = input && typeof input === "object" ? input : {};
      data = {
        ...structuredClone(bundled),
        ...Object.fromEntries(
          PROVIDER_SECTIONS.map((section) => [
            section,
            acceptProviders(section, remote[section], bundled[section]),
          ])
        ),
        ...Object.fromEntries(
          MAP_SECTIONS.map((section) => [section, acceptMap(section, remote[section], bundled[section])])
        ),
      };
    } catch {
      data = structuredClone(bundled);
    }
    return settleReferences(selectCatalogForVersion(data, bundled, appVersion));
  } catch {
    // Only a malformed bundle gets here; the app keeps using it exactly as shipped.
    return structuredClone(bundled);
  }
}

const manifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  manifestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  publishedAt: z.iso.datetime(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  // The publisher's own reader, so desktop sync can vendor exactly that code.
  contractHashes: z.object({ schema: sha256, envelope: sha256, selection: sha256 }),
  // Every app reader this catalog was run through in CI. An app applies the catalog
  // only when its own contract is listed.
  testedClientContracts: z.array(sha256).min(1).max(1000),
  data: z.record(z.string(), z.unknown()),
});
function validateManifest(input) {
  return manifestSchema.parse(input);
}

function contractId(hashes) {
  return createHash("sha256")
    .update(`schema:${hashes.schema}\nenvelope:${hashes.envelope}\nselection:${hashes.selection}\n`)
    .digest("hex");
}

module.exports = {
  SCHEMA_VERSION,
  PROVIDER_SECTIONS,
  MAP_SECTIONS,
  isActive,
  validateCatalog,
  assertCompatibleCatalog,
  capabilityChanges,
  acceptCatalog,
  settleReferences,
  validateManifest,
  contractId,
};
