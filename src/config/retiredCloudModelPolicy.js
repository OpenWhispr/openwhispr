// Pure policy shared by main-process catalogue filtering and renderer requests.
import { retiredReplacement } from "../models/modelLifecycle.js";

export const RETIRED_CLOUD_MODELS = {
  // qwen3-32b and both Llamas (retired 2026-08-16) were swept under the
  // original key, which predates this table. Groq shut down both Compound
  // systems on 2026-09-21 with no named successor; installed builds had
  // already written that key, so adding them rotated it.
  groq: {
    migratedKey: "_retiredGroqModelsMigrated2",
    models: {
      "qwen/qwen3-32b": "openai/gpt-oss-120b",
      "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
      "llama-3.1-8b-instant": "openai/gpt-oss-20b",
      "groq/compound": "openai/gpt-oss-120b",
      "groq/compound-mini": "openai/gpt-oss-20b",
    },
  },
  // All three shipped as seed entries — deepseek-v4-pro in v1.7.4, kimi-k2-6
  // through v1.8.3, glm-5-2 through v1.9.2 — so anyone who simply took a
  // default can be on one. deepseek-v4-flash was never seeded but was served
  // live, and was deepseek-v4-pro's replacement here, until Tinfoil retired it
  // for deepseek-v4-1-flash (seen 2026-09-18). The first key shipped in
  // v1.10.0, so adding it rotated the key. GLM-5.3 Flash retires October 9,
  // 2026; key 3 moves existing selections before that cutoff.
  tinfoil: {
    migratedKey: "_retiredTinfoilModelsMigrated3",
    models: {
      "glm-5-2": "glm-5-3",
      "glm-5-3-flash": "glm-5-3",
      "deepseek-v4-pro": "deepseek-v4-1-flash",
      "deepseek-v4-flash": "deepseek-v4-1-flash",
      "kimi-k2-6": "kimi-k3",
    },
  },
  // OpenAI shut down gpt-4.1-nano on 2026-10-23. GPT-6 Luna is its fastest,
  // lowest-cost successor.
  openai: {
    migratedKey: "_retiredOpenAIModelsMigrated",
    models: {
      "gpt-4.1-nano": "gpt-6-luna",
    },
  },
};

export function resolveRetiredCloudModel(provider, model) {
  const models = RETIRED_CLOUD_MODELS[provider]?.models;
  if (models && Object.hasOwn(models, model)) return models[model];
  // Retirements published in the model catalog, so a stale selection never 404s.
  return retiredReplacement("cloudProviders", provider, model) ?? model;
}

export function isSelectableTinfoilModel(model) {
  return resolveRetiredCloudModel("tinfoil", model.id) === model.id;
}

// Names must survive removal from both the live catalogue and the saved cache.
export const RETIRED_TINFOIL_MODEL_NAMES = {
  "glm-5-2": "GLM-5.2",
  "glm-5-3-flash": "GLM-5.3 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "kimi-k2-6": "Kimi K2.6",
};
