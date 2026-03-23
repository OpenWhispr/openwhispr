import {
  getCloudModel,
  type ReasoningEffortCapability,
  type ReasoningEffortProvider,
} from "./ModelRegistry";

export const AUTO_REASONING_EFFORT = "";

type DynamicModelPayload = Record<string, unknown>;
type SnapshotCapabilityPattern = {
  pattern: RegExp;
  capability: ReasoningEffortCapability;
};

const OPENAI_REASONING_PATTERNS: SnapshotCapabilityPattern[] = [
  {
    pattern: /^gpt-5\.4-pro(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["medium", "high", "xhigh"],
    },
  },
  {
    pattern: /^gpt-5\.2-pro(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["medium", "high", "xhigh"],
    },
  },
  {
    pattern: /^gpt-5-pro(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["high"],
      defaultValue: "high",
    },
  },
  {
    pattern: /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["none", "low", "medium", "high", "xhigh"],
      defaultValue: "none",
    },
  },
  {
    pattern: /^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["none", "low", "medium", "high", "xhigh"],
      defaultValue: "none",
    },
  },
  {
    pattern: /^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["none", "low", "medium", "high"],
      defaultValue: "none",
    },
  },
  {
    pattern: /^gpt-5(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["minimal", "low", "medium", "high"],
    },
  },
  {
    pattern: /^gpt-5-mini(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["minimal", "low", "medium", "high"],
    },
  },
  {
    pattern: /^gpt-5-nano(?:-\d{4}-\d{2}-\d{2})?$/,
    capability: {
      provider: "openai",
      options: ["minimal", "low", "medium", "high"],
    },
  },
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNonEmptyString).map((entry) => entry.trim());
}

function getNestedValue(
  source: DynamicModelPayload,
  keys: Array<string | readonly string[]>
): unknown | undefined {
  for (const key of keys) {
    if (typeof key === "string" && key in source) {
      return source[key];
    }

    if (Array.isArray(key)) {
      let current: unknown = source;
      let missing = false;
      for (const part of key) {
        if (!current || typeof current !== "object" || !(part in current)) {
          missing = true;
          break;
        }
        current = (current as Record<string, unknown>)[part];
      }
      if (!missing) return current;
    }
  }
  return undefined;
}

function normalizeProvider(value: unknown): ReasoningEffortProvider | null {
  if (!isNonEmptyString(value)) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "anthropic" || normalized === "gemini") {
    return normalized;
  }
  return null;
}

function inferOpenAiReasoningEffortCapability(modelId: string): ReasoningEffortCapability | null {
  const normalizedModelId = modelId.trim().toLowerCase();
  const matched = OPENAI_REASONING_PATTERNS.find(({ pattern }) => pattern.test(normalizedModelId));
  return matched?.capability ?? null;
}

export function getModelReasoningEffortCapability(modelId: string): ReasoningEffortCapability | null {
  return getCloudModel(modelId)?.reasoningEffort ?? inferOpenAiReasoningEffortCapability(modelId);
}

export function isReasoningEffortSupported(
  capability: ReasoningEffortCapability | null | undefined,
  value: string | null | undefined
): boolean {
  if (!capability || !isNonEmptyString(value)) return false;
  return capability.options.includes(value);
}

export function hasSelectableReasoningEffort(
  capability: ReasoningEffortCapability | null | undefined
): boolean {
  return Boolean(capability && capability.options.length > 1);
}

export function extractDynamicReasoningEffortCapability(
  source: DynamicModelPayload
): ReasoningEffortCapability | null {
  const modelId =
    (isNonEmptyString(source.id) ? source.id.trim() : null) ||
    (isNonEmptyString(source.name) ? source.name.trim() : null);
  const options =
    toStringArray(
      getNestedValue(source, [
        "supportedReasoningEfforts",
        "supported_reasoning_efforts",
        "reasoningEfforts",
        "reasoning_efforts",
        ["capabilities", "supportedReasoningEfforts"],
        ["capabilities", "supported_reasoning_efforts"],
        ["capabilities", "reasoningEfforts"],
        ["capabilities", "reasoning_efforts"],
        ["reasoning", "supportedEfforts"],
        ["reasoning", "supported_efforts"],
      ])
    ) ||
    [];

  if (options.length === 0) {
    return modelId ? inferOpenAiReasoningEffortCapability(modelId) : null;
  }

  const provider =
    normalizeProvider(
      getNestedValue(source, [
        "reasoningProvider",
        "reasoning_provider",
        "reasoningMode",
        "reasoning_mode",
        ["capabilities", "reasoningProvider"],
        ["capabilities", "reasoning_provider"],
      ])
    ) || "openai";

  const defaultValue = getNestedValue(source, [
    "defaultReasoningEffort",
    "default_reasoning_effort",
    ["capabilities", "defaultReasoningEffort"],
    ["capabilities", "default_reasoning_effort"],
    ["reasoning", "defaultEffort"],
    ["reasoning", "default_effort"],
  ]);

  return {
    provider,
    options,
    defaultValue: isNonEmptyString(defaultValue) ? defaultValue.trim() : undefined,
  };
}
