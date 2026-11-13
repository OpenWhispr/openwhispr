// Loads the local cleanup model when a dictation starts, so a llama-server the
// idle timeout stopped reloads while the user speaks rather than after the
// transcript is ready. It never replaces a different model a running server
// holds: another scope may be mid-request on it, and the cleanup request
// still swaps models itself as it always has.
function prewarmLocalCleanup(modelManager, env = process.env) {
  const modelId = env.LOCAL_CLEANUP_MODEL;
  if (env.CLEANUP_PROVIDER !== "local" || !modelId) return Promise.resolve(false);
  if (modelManager.getServerStatus().running && modelManager.currentServerModelId !== modelId) {
    return Promise.resolve(false);
  }
  return modelManager.prewarmServer(modelId);
}

module.exports = { prewarmLocalCleanup };
