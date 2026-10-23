import { LOCAL_MODELS_CHANGED_EVENT } from "../hooks/useModelDownload";

/** Delete each local model family, retaining the aggregate result for Settings. */
export async function removeLocalModels(): Promise<boolean> {
  const results = await Promise.allSettled([
    window.electronAPI?.deleteAllWhisperModels?.(),
    window.electronAPI?.deleteAllParakeetModels?.(),
    window.electronAPI?.modelDeleteAll?.(),
  ]);

  // A family can delete some files before reporting failure. Re-check disk truth
  // even then, without claiming every model was removed or clearing selections.
  window.dispatchEvent(new Event(LOCAL_MODELS_CHANGED_EVENT));

  return !results.some(
    (result) =>
      result.status === "rejected" ||
      (result.status === "fulfilled" && result.value && !result.value.success)
  );
}
