import type { InferenceProvider } from "./types";

// OpenWhispr cloud inference has been removed. This stub keeps the provider
// id registered so existing settings ("openwhispr" in cleanupCloudMode etc.)
// don't reach the registry with `undefined`. Any call throws a clear message.
export const openwhisprProvider: InferenceProvider = {
  id: "openwhispr",
  async call() {
    const err: Error & { code?: string } = new Error(
      "OpenWhispr cloud inference is no longer available. Switch to OpenAI, Anthropic, Gemini, or a local model in Settings."
    );
    err.code = "OPENWHISPR_REMOVED";
    throw err;
  },
};
