/**
 * Local STT cold-start / no-GPU startup UX (#1078).
 *
 * When pre-warm is skipped or still in progress, or when local mode runs
 * without GPU acceleration, surface a subtle tray + Settings hint.
 */

export function isSelectedLocalModelDownloaded({
  localTranscriptionProvider,
  whisperModel,
  parakeetModel,
  whisperModels = [],
  parakeetModels = [],
}) {
  const id =
    localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
  if (!id || typeof id !== "string") return false;

  const models = localTranscriptionProvider === "nvidia" ? parakeetModels : whisperModels;
  if (!Array.isArray(models)) return false;

  return models.some(
    (m) =>
      m &&
      (m.model === id || m.id === id || m.name === id || m.modelId === id) &&
      (m.downloaded === true || m.isDownloaded === true)
  );
}

export function isLocalServerReady(provider, whisperStatus, parakeetStatus) {
  if (provider === "nvidia") {
    return !!(parakeetStatus && parakeetStatus.running);
  }
  return !!(whisperStatus && whisperStatus.running);
}

export function hasWhisperGpuAcceleration({
  cudaEnabled,
  cudaDownloaded,
  vulkanEnabled,
  vulkanDownloaded,
}) {
  return (
    (!!cudaEnabled && !!cudaDownloaded) || (!!vulkanEnabled && !!vulkanDownloaded)
  );
}

/**
 * @returns {'cold-start' | 'no-gpu' | null}
 */
export function resolveLocalColdStartHint({
  useLocalWhisper,
  localTranscriptionProvider,
  selectedModelDownloaded,
  localServerReady,
  hasNvidiaGpu,
  whisperGpuAcceleration,
}) {
  if (!useLocalWhisper || !selectedModelDownloaded) return null;

  if (!localServerReady) return "cold-start";

  if (localTranscriptionProvider === "nvidia") {
    return hasNvidiaGpu ? null : "no-gpu";
  }

  if (!whisperGpuAcceleration && !hasNvidiaGpu) return "no-gpu";
  return null;
}

export function resolveLocalColdStartTrayKey(hint) {
  if (hint === "cold-start") return "tray.tooltipLocalColdStart";
  if (hint === "no-gpu") return "tray.tooltipLocalNoGpu";
  return "tray.tooltip";
}

export function resolveLocalColdStartBadgeKeys(hint) {
  if (hint === "cold-start") {
    return {
      badge: "settingsPage.transcription.coldStartBadge",
      hint: "settingsPage.transcription.coldStartHint",
    };
  }
  if (hint === "no-gpu") {
    return {
      badge: "settingsPage.transcription.noGpuBadge",
      hint: "settingsPage.transcription.noGpuHint",
    };
  }
  return null;
}
