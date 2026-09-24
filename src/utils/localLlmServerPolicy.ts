import type { ResolvedLLMConfig } from "../stores/settingsStore";

// One llama-server serves every inference scope, so moving a single scope off
// "local" must not stop it while another scope still runs a local model.
export function isLocalLlmServerNeeded(
  configs: ReadonlyArray<Pick<ResolvedLLMConfig, "mode" | "model">>
): boolean {
  return configs.some((config) => config.mode === "local" && !!config.model);
}
