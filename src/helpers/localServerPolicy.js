// Which model each LLM scope needs pre-warmed in the shared llama-server, and
// whether that server can be stopped.
//
// A scope stores its local selection as a catalog family id (qwen, gemma, …),
// never the literal "local", so only the scope's mode says whether it runs
// locally. A scope that is switched off never runs, so it needs no server.
export function resolveLocalServerNeeds({
  useCleanupModel,
  cleanupMode,
  cleanupModel,
  useDictationAgent,
  dictationAgentMode,
  dictationAgentModel,
}) {
  const cleanup = useCleanupModel && cleanupMode === "local" ? cleanupModel?.trim() || "" : "";
  const dictationAgent =
    useDictationAgent && dictationAgentMode === "local" ? dictationAgentModel?.trim() || "" : "";

  return { cleanup, dictationAgent, stopServer: !cleanup && !dictationAgent };
}
