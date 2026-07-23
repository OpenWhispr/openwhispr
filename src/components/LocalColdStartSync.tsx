import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { setLocalColdStartHint, type LocalColdStartHint } from "../stores/localColdStartStore";
import {
  hasWhisperGpuAcceleration,
  isLocalServerReady,
  isSelectedLocalModelDownloaded,
  resolveLocalColdStartHint,
} from "../helpers/localColdStart.js";

const POLL_MS = 2500;

/**
 * Keeps tray tooltip + Settings badge aligned with local STT pre-warm / GPU state (#1078).
 */
export default function LocalColdStartSync() {
  const useLocalWhisper = useSettingsStore((s) => s.useLocalWhisper);
  const localTranscriptionProvider = useSettingsStore((s) => s.localTranscriptionProvider);
  const whisperModel = useSettingsStore((s) => s.whisperModel);
  const parakeetModel = useSettingsStore((s) => s.parakeetModel);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      const api = window.electronAPI;
      if (!api?.listWhisperModels || !api?.listParakeetModels) return;

      const [
        whisperResult,
        parakeetResult,
        whisperStatus,
        parakeetStatus,
        cudaStatus,
        vulkanStatus,
        gpus,
      ] = await Promise.all([
        api.listWhisperModels().catch(() => ({ models: [] })),
        api.listParakeetModels().catch(() => ({ models: [] })),
        api.whisperServerStatus?.().catch(() => ({ running: false })),
        api.parakeetServerStatus?.().catch(() => ({ running: false })),
        api.getCudaWhisperStatus?.().catch(() => null),
        api.getVulkanWhisperStatus?.().catch(() => null),
        api.listGpus?.().catch(() => []),
      ]);
      if (cancelled) return;

      const settings = useSettingsStore.getState();
      const provider = settings.localTranscriptionProvider === "nvidia" ? "nvidia" : "whisper";
      const selectedModelDownloaded = isSelectedLocalModelDownloaded({
        localTranscriptionProvider: provider,
        whisperModel: settings.whisperModel,
        parakeetModel: settings.parakeetModel,
        whisperModels: whisperResult?.models,
        parakeetModels: parakeetResult?.models,
      });

      const cudaDownloaded = !!cudaStatus?.downloaded;
      const vulkanDownloaded = !!vulkanStatus?.downloaded;
      // Env-backed flags are reflected by downloaded+enabled usage in main; treat
      // a downloaded CUDA/Vulkan binary as acceleration available once present.
      const whisperGpuAcceleration = hasWhisperGpuAcceleration({
        cudaEnabled: cudaDownloaded,
        cudaDownloaded,
        vulkanEnabled: vulkanDownloaded,
        vulkanDownloaded,
      });

      const hasNvidiaGpu =
        (Array.isArray(gpus) && gpus.length > 0) ||
        !!cudaStatus?.gpuInfo?.hasNvidiaGpu ||
        !!vulkanStatus?.hasNvidiaGpu;

      const next = resolveLocalColdStartHint({
        useLocalWhisper: settings.useLocalWhisper,
        localTranscriptionProvider: provider,
        selectedModelDownloaded,
        localServerReady: isLocalServerReady(provider, whisperStatus, parakeetStatus),
        hasNvidiaGpu,
        whisperGpuAcceleration,
      }) as LocalColdStartHint;

      setLocalColdStartHint(next);
      await api.syncLocalColdStartHint?.({ hint: next }).catch(() => {});

      if (!cancelled && next === "cold-start") {
        timer = setTimeout(() => {
          void run();
        }, POLL_MS);
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [useLocalWhisper, localTranscriptionProvider, whisperModel, parakeetModel]);

  return null;
}
