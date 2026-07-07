import type { ReasoningConfig } from "./BaseReasoningService";
import type { InferenceScope } from "../config/inferenceScopes";
import type { InferenceMode } from "../types/electron";

export type ReasoningUnavailableReason =
  | "account_required_for_hosted"
  | "model_required"
  | "provider_required"
  | "endpoint_required";

export interface ReasoningRouteConfig {
  scope: InferenceScope;
  mode: InferenceMode;
  provider: string;
  model: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
  disableThinking?: boolean;
}

export type ReasoningRequest =
  | {
      usable: true;
      route: InferenceMode | "lan";
      provider: string;
      modelId: string;
      config: ReasoningConfig;
    }
  | {
      usable: false;
      reason: ReasoningUnavailableReason;
      alternatives: Array<"local" | "providers" | "self-hosted">;
    };

export function resolveReasoningRequest(input: {
  isSignedIn: boolean;
  config: ReasoningRouteConfig;
}): ReasoningRequest {
  const { config } = input;
  const disableThinking = config.disableThinking;

  if (config.mode === "openwhispr") {
    if (!input.isSignedIn || config.cloudMode !== "openwhispr") {
      return unavailable("account_required_for_hosted");
    }
    return {
      usable: true,
      route: "openwhispr",
      provider: "openwhispr",
      modelId: "",
      config: {
        provider: "openwhispr",
        disableThinking,
      },
    };
  }

  if (config.mode === "local") {
    if (!config.model) return unavailable("model_required");
    return {
      usable: true,
      route: "local",
      provider: "local",
      modelId: config.model,
      config: {
        provider: "local",
        disableThinking,
      },
    };
  }

  if (config.mode === "providers") {
    if (!config.provider) return unavailable("provider_required");
    if (!config.model) return unavailable("model_required");
    return {
      usable: true,
      route: "providers",
      provider: config.provider,
      modelId: config.model,
      config: {
        provider: config.provider,
        baseUrl: config.cloudBaseUrl?.trim() || undefined,
        customApiKey: config.customApiKey?.trim() || undefined,
        disableThinking,
      },
    };
  }

  if (config.mode === "self-hosted") {
    const lanUrl = config.remoteUrl?.trim();
    if (!lanUrl) return unavailable("endpoint_required");
    return {
      usable: true,
      route: "lan",
      provider: "lan",
      modelId: config.model?.trim() || "default",
      config: {
        provider: "lan",
        lanUrl,
        customApiKey: config.customApiKey?.trim() || undefined,
        disableThinking,
      },
    };
  }

  if (config.mode === "enterprise") {
    if (!config.provider) return unavailable("provider_required");
    if (!config.model) return unavailable("model_required");
    return {
      usable: true,
      route: "enterprise",
      provider: config.provider,
      modelId: config.model,
      config: {
        provider: config.provider,
        disableThinking,
      },
    };
  }

  return unavailable("model_required");
}

function unavailable(reason: ReasoningUnavailableReason): ReasoningRequest {
  return {
    usable: false,
    reason,
    alternatives: ["local", "providers"],
  };
}
