// Which model each LLM scope needs pre-warmed in the shared llama-server, and
// whether that server can be stopped. This is the single rule for stopping it:
// every scope that can run locally shares the one server, so it may only stop
// once none of them needs the model it holds.
//
// A scope stores its local selection as a catalog family id (qwen, gemma, …),
// never the literal "local", so only the scope's mode says whether it runs
// locally. A scope that is switched off never runs, so it needs no server.
// Modes and models must be the resolved, policy-effective ones (see
// selectLocalServerPrefs), since those are what the request path runs on.
// dictationAgentVision is absent because it can never be local.
const localModelOf = (enabled, mode, model) =>
  enabled && mode === "local" ? model?.trim() || "" : "";

export function resolveLocalServerNeeds({
  useCleanupModel,
  cleanupMode,
  cleanupModel,
  useDictationAgent,
  dictationAgentMode,
  dictationAgentModel,
  noteFormattingMode,
  noteFormattingModel,
  chatAgentMode,
  chatAgentModel,
  useDictationTranslation,
  translationMode,
  translationModel,
}) {
  const cleanup = localModelOf(useCleanupModel, cleanupMode, cleanupModel);
  const dictationAgent = localModelOf(useDictationAgent, dictationAgentMode, dictationAgentModel);
  const models = [
    cleanup,
    dictationAgent,
    localModelOf(true, noteFormattingMode, noteFormattingModel),
    localModelOf(true, chatAgentMode, chatAgentModel),
    localModelOf(useDictationTranslation, translationMode, translationModel),
  ].filter((model, index, all) => model && all.indexOf(model) === index);

  return { cleanup, dictationAgent, models };
}

// The server holds one model, so it can also go when no scope needs the model
// it has loaded: the next local request reloads it with the right one anyway.
export function shouldStopLocalServer({ models }, loadedModelId) {
  return loadedModelId ? !models.includes(loadedModelId) : models.length === 0;
}
