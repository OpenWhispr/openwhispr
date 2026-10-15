const { z } = require("zod");
const { selectCatalogForVersion, isRegistryVersion } = require("./registrySelection.js");

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
const modelUrl = z.string().max(2048).refine(isModelUrl, "Unsupported model download URL");
const description = {
  name: text,
  description: text,
  descriptionKey: text.optional(),
  minAppVersion: version.optional(),
};
const cloudModel = z
  .object({
    ...description,
    id,
    disableThinking: z.boolean().optional(),
    supportsThinking: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    tokenParam: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    supportsTemperature: z.boolean().optional(),
  })
  .strict();
const transcriptionModel = z
  .object({ ...description, id, streaming: z.boolean().optional() })
  .strict();
const localModel = z
  .object({
    ...description,
    id,
    size: text,
    sizeBytes: positive,
    fileName: safeName,
    quantization: text,
    contextLength: z.number().int().positive().max(10000000),
    hfRepo,
    revision: revision.optional(),
    recommended: z.boolean().optional(),
    supportsThinking: z.boolean().optional(),
    sha256: sha256.optional(),
    draftHfRepo: hfRepo.optional(),
    draftRevision: revision.optional(),
    draftFileName: safeName.optional(),
    draftSizeBytes: positive.optional(),
    draftSha256: sha256.optional(),
  })
  .strict()
  .refine((model) => {
    const draft = [model.draftHfRepo, model.draftFileName, model.draftSizeBytes];
    return draft.every((value) => value === undefined)
      ? model.draftSha256 === undefined && model.draftRevision === undefined
      : draft.every((value) => value !== undefined);
  }, "Incomplete draft artifact");
const whisperModel = z
  .object({
    ...description,
    size: text,
    sizeMb: positive,
    expectedSizeBytes: positive.optional(),
    fileName: safeName,
    downloadUrl: modelUrl,
    recommended: z.boolean().optional(),
    sha256: sha256.optional(),
  })
  .strict();
const parakeetModel = z
  .object({
    ...description,
    size: text,
    sizeMb: positive,
    expectedSizeBytes: positive.optional(),
    language: text,
    supportedLanguages: z.array(z.string().min(1).max(20)).max(1000),
    downloadUrl: modelUrl,
    extractDir: safeName,
    manifestUrl: modelUrl.optional(),
    runtime: z.enum(["offline", "online"]).optional(),
    modelType: z.enum(["transducer", "cohere-transcribe"]).optional(),
    sherpaModelType: z.literal("nemo_transducer").optional(),
    recommended: z.boolean().optional(),
    sha256: sha256.optional(),
    license: text.optional(),
    organization: z
      .object({ id: z.enum(["oruk", "nvidia", "cohere"]), name: text })
      .strict()
      .optional(),
    modelCardUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://huggingface.co/"))
      .optional(),
  })
  .strict();
const provider = { id: safeName, name: text };
const list = (schema) => z.array(schema).max(1000);
const catalogSchema = z
  .object({
    whisperModels: z.record(safeName, whisperModel),
    parakeetModels: z.record(safeName, parakeetModel),
    cloudProviders: list(
      z
        .object({
          ...provider,
          defaultModel: id.optional(),
          models: list(cloudModel),
        })
        .strict()
    ),
    enterpriseProviders: list(
      z
        .object({
          ...provider,
          allowCustomModelId: z.boolean(),
          defaultModel: id.optional(),
          models: list(cloudModel),
        })
        .strict()
    ),
    transcriptionProviders: list(
      z
        .object({
          ...provider,
          baseUrl: z.string().url(),
          batchModel: id.optional(),
          models: list(transcriptionModel),
        })
        .strict()
    ),
    localProviders: list(
      z
        .object({
          ...provider,
          baseUrl: z.literal("https://huggingface.co"),
          models: list(localModel),
        })
        .strict()
    ),
    // Preserved legacy sections have no runtime consumer. They cannot be edited remotely.
    diarizationModels: z.record(z.string(), z.json()),
    openwhisprCloudModels: z.json(),
  })
  .strict();

const PROVIDER_SECTIONS = [
  "cloudProviders",
  "enterpriseProviders",
  "transcriptionProviders",
  "localProviders",
];
const MAP_SECTIONS = ["whisperModels", "parakeetModels"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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

function validateCatalog(input) {
  rejectUnsafeKeys(input);
  const data = catalogSchema.parse(input);
  for (const section of PROVIDER_SECTIONS) {
    const providers = new Set();
    for (const item of data[section]) {
      requireCondition(!providers.has(item.id), `Duplicate provider ${item.id}`);
      providers.add(item.id);
      const models = new Set();
      for (const model of item.models) {
        requireCondition(!models.has(model.id), `Duplicate model ${item.id}/${model.id}`);
        models.add(model.id);
      }
      if (item.defaultModel)
        requireCondition(models.has(item.defaultModel), `Missing default for ${item.id}`);
    }
  }
  return data;
}

const NATIVE_MUTABLE_FIELDS = new Set([
  "name",
  "description",
  "descriptionKey",
  "minAppVersion",
  "sha256",
  "draftSha256",
]);
function assertNativeIdentity(next, previous) {
  for (const key of new Set([...Object.keys(next), ...Object.keys(previous)])) {
    if (NATIVE_MUTABLE_FIELDS.has(key)) continue;
    requireCondition(same(next[key], previous[key]), `Changed native model identity: ${key}`);
  }
  for (const key of ["sha256", "draftSha256"]) {
    if (previous[key])
      requireCondition(next[key] === previous[key], `Changed artifact digest: ${key}`);
  }
}
function assertNewDownload(model) {
  requireCondition(!!model.sha256, "New model download requires sha256");
  if (model.hfRepo)
    requireCondition(!!model.revision, "New model download requires a pinned revision");
  for (const field of ["downloadUrl", "manifestUrl"]) {
    if (!model[field]) continue;
    const url = new URL(model[field]);
    if (url.hostname === "huggingface.co")
      requireCondition(
        /^\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//.test(url.pathname),
        "New model download requires a pinned revision"
      );
  }
  if (model.draftFileName) {
    requireCondition(!!model.draftRevision, "New draft download requires a pinned revision");
    requireCondition(!!model.draftSha256, "New draft download requires draftSha256");
  }
}

function assertCompatibleCatalog(input, previousInput) {
  const next = validateCatalog(input);
  const previous = validateCatalog(previousInput);
  for (const section of PROVIDER_SECTIONS) {
    requireCondition(
      same(
        next[section].map((p) => p.id),
        previous[section].map((p) => p.id)
      ),
      `Changed provider order in ${section}`
    );
    requireCondition(
      next[section].length === previous[section].length,
      `Changed providers in ${section}`
    );
    for (const oldProvider of previous[section]) {
      const provider = next[section].find((item) => item.id === oldProvider.id);
      requireCondition(!!provider, `Removed provider ${oldProvider.id}`);
      for (const field of ["baseUrl", "allowCustomModelId", "defaultModel", "batchModel"]) {
        requireCondition(
          provider[field] === oldProvider[field],
          `Changed provider contract ${provider.id}/${field}`
        );
      }
      requireCondition(
        provider.models[0]?.id === oldProvider.models[0]?.id,
        `Changed default model for ${provider.id}`
      );
      requireCondition(
        same(
          provider.models.slice(0, oldProvider.models.length).map((m) => m.id),
          oldProvider.models.map((m) => m.id)
        ),
        `Existing models must retain their order in ${provider.id}`
      );
      for (const model of provider.models) {
        if (!oldProvider.models.some((old) => old.id === model.id)) {
          const sections =
            section === "localProviders"
              ? ["localProviders"]
              : section === "transcriptionProviders"
                ? ["transcriptionProviders"]
                : ["cloudProviders", "enterpriseProviders"];
          const matches = sections
            .flatMap((key) => next[key])
            .flatMap((p) => p.models)
            .filter((m) => m.id === model.id);
          requireCondition(matches.length === 1, `Ambiguous new model ID ${model.id}`);
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
          if (section === "localProviders") {
            const occupied = next.localProviders
              .flatMap((p) => p.models)
              .filter((m) => m !== model)
              .flatMap((m) => [m.fileName, m.draftFileName].filter(Boolean))
              .map((name) => name.toLowerCase());
            requireCondition(
              !occupied.includes(model.fileName.toLowerCase()) &&
                (!model.draftFileName ||
                  (!occupied.includes(model.draftFileName.toLowerCase()) &&
                    model.fileName.toLowerCase() !== model.draftFileName.toLowerCase())),
              "Colliding model artifact filename"
            );
          }
        }
      }
      for (const oldModel of oldProvider.models) {
        const model = provider.models.find((item) => item.id === oldModel.id);
        requireCondition(!!model, `Removed model ${provider.id}/${oldModel.id}`);
        requireCondition(
          model.minAppVersion === oldModel.minAppVersion,
          "Changed published minimum app version"
        );
        if (section === "localProviders") assertNativeIdentity(model, oldModel);
        if (section === "transcriptionProviders")
          requireCondition(
            model.streaming === oldModel.streaming,
            "Changed transcription transport"
          );
      }
      if (section === "localProviders")
        for (const model of provider.models) {
          if (!oldProvider.models.some((old) => old.id === model.id)) assertNewDownload(model);
        }
    }
  }
  for (const section of MAP_SECTIONS) {
    requireCondition(
      same(
        Object.keys(next[section]).slice(0, Object.keys(previous[section]).length),
        Object.keys(previous[section])
      ),
      `Existing models must retain their order in ${section}`
    );
    for (const [modelId, model] of Object.entries(next[section])) {
      if (Object.hasOwn(previous[section], modelId)) continue;
      requireCondition(
        MAP_SECTIONS.filter((key) => Object.hasOwn(next[key], modelId)).length === 1,
        `Ambiguous local model ID ${modelId}`
      );
      if (section === "whisperModels")
        requireCondition(
          Object.entries(next.whisperModels).every(
            ([id, other]) =>
              id === modelId || other.fileName.toLowerCase() !== model.fileName.toLowerCase()
          ),
          "Colliding Whisper filename"
        );
      if (section === "parakeetModels") {
        requireCondition(
          Object.keys(next.parakeetModels).filter(
            (id) => id.toLowerCase() === modelId.toLowerCase()
          ).length === 1,
          "Colliding Parakeet directory"
        );
        const engine = (m) => [
          m.runtime || "offline",
          m.modelType || "transducer",
          m.sherpaModelType || "auto",
        ];
        requireCondition(
          Object.values(previous.parakeetModels).some((old) => same(engine(old), engine(model))),
          "Unsupported native engine combination"
        );
      }
    }
    for (const [modelId, oldModel] of Object.entries(previous[section])) {
      requireCondition(Object.hasOwn(next[section], modelId), `Removed model ${modelId}`);
      requireCondition(
        next[section][modelId].minAppVersion === oldModel.minAppVersion,
        "Changed published minimum app version"
      );
      assertNativeIdentity(next[section][modelId], oldModel);
    }
    for (const [modelId, model] of Object.entries(next[section]))
      if (!Object.hasOwn(previous[section], modelId)) assertNewDownload(model);
  }
  for (const section of ["diarizationModels", "openwhisprCloudModels"])
    requireCondition(same(next[section], previous[section]), `Changed legacy section ${section}`);
  return next;
}

function selectCatalog(input, fallback, appVersion) {
  const data = validateCatalog(input);
  version.parse(appVersion);
  return selectCatalogForVersion(data, fallback, appVersion);
}

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractHashes: z.object({ schema: sha256, envelope: sha256, selection: sha256 }).strict(),
    manifestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    publishedAt: z.iso.datetime(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    data: catalogSchema,
  })
  .strict();
function validateManifest(input) {
  const manifest = manifestSchema.parse(input);
  manifest.data = validateCatalog(manifest.data);
  return manifest;
}

module.exports = {
  validateCatalog,
  assertCompatibleCatalog,
  selectCatalog,
  validateManifest,
  isModelUrl,
};
