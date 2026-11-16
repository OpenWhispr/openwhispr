import { reasoningModelBelongsToProvider, type ResolvedLLMConfig } from "../stores/settingsStore";
import { isProviderValidForMode } from "../models/ModelRegistry";
import type { InferenceMode } from "../types/electron";

type LLMConfigPatch = Partial<Omit<ResolvedLLMConfig, "scope">>;

// Every mode shares the scope's provider and model, so a switch clears what the
// new mode can't use. In Providers that includes a model the kept provider
// doesn't serve, such as a self-hosted model id left under Groq.
export function modeSwitchPatch(
  current: Pick<ResolvedLLMConfig, "provider" | "model">,
  mode: InferenceMode
): LLMConfigPatch {
  const patch: LLMConfigPatch = {
    mode,
    cloudMode: mode === "openwhispr" ? "openwhispr" : "byok",
  };
  if (!isProviderValidForMode(current.provider, mode)) {
    patch.provider = "";
    patch.model = "";
  } else if (
    mode === "providers" &&
    !reasoningModelBelongsToProvider(current.provider, current.model)
  ) {
    patch.model = "";
  }
  return patch;
}
