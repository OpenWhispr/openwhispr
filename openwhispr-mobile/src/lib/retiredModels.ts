import type { InferenceSelection } from '@/lib/mobileProviders';
import type { UserConfig } from '@/types';

// Models their provider has shut down, and the model a saved selection moves to. The catalog no
// longer offers them, so the sweep can run on every launch without overriding a later choice.
// Desktop keeps the same table in src/config/retiredCloudModels.ts.
const RETIRED_MODELS: Record<string, Record<string, string>> = {
  openai: { 'gpt-4.1-nano': 'gpt-6-luna' },
};

function replacementFor(selection: InferenceSelection | undefined): string | undefined {
  if (!selection?.providerId || !selection.modelId) return undefined;
  return RETIRED_MODELS[selection.providerId]?.[selection.modelId];
}

// The config with every saved or remembered selection of a retired model moved to its
// replacement; the same object when nothing pointed at one, so the caller saves only on a change.
export function withoutRetiredModels(config: UserConfig): UserConfig {
  let changed = false;
  const sweep = (selection: InferenceSelection | undefined): InferenceSelection | undefined => {
    const modelId = replacementFor(selection);
    if (!selection || !modelId) return selection;
    changed = true;
    return { ...selection, modelId };
  };
  const inference =
    config.inference &&
    Object.fromEntries(
      Object.entries(config.inference).map(([scope, selection]) => [scope, sweep(selection)]),
    );
  const rememberedInference =
    config.rememberedInference &&
    Object.fromEntries(
      Object.entries(config.rememberedInference).map(([scope, byMode]) => [
        scope,
        byMode &&
          Object.fromEntries(
            Object.entries(byMode).map(([key, selection]) => [key, sweep(selection)]),
          ),
      ]),
    );
  return changed ? { ...config, inference, rememberedInference } : config;
}
