import { useEffect, useState } from "react";
import { eligibleGpuOffers, type GpuOfferInputs, type GpuOffers } from "../utils/gpuBannerPolicy";
import type { Platform } from "../utils/platform";

type GpuBannerSettings = Omit<GpuOfferInputs, "agentAllowedByPolicy">;

interface UseGpuBannerAvailabilityOptions {
  settings: GpuBannerSettings;
  agentAllowedByPolicy: boolean;
  dismissed: boolean;
  settingsOpen: boolean;
  platform: Platform;
}

const EMPTY_GPU_OFFERS: GpuOffers = {
  transcription: false,
  intelligence: null,
};

export function useGpuBannerAvailability({
  settings,
  agentAllowedByPolicy,
  dismissed,
  settingsOpen,
  platform,
}: UseGpuBannerAvailabilityOptions): GpuOffers {
  const [availability, setAvailability] = useState<GpuOffers>(EMPTY_GPU_OFFERS);

  useEffect(() => {
    if (platform === "darwin" || dismissed || settingsOpen) return;

    const offers = eligibleGpuOffers({ ...settings, agentAllowedByPolicy });
    // A run that loses its settings mid-probe must not publish: switching to a
    // cloud mode resolves with no IPC at all, so an older local-mode run would
    // otherwise land last and re-raise the banner for the rest of the session.
    let cancelled = false;
    const detect = async () => {
      const results: GpuOffers = { ...EMPTY_GPU_OFFERS };
      if (offers.transcription) {
        try {
          const status = await window.electronAPI?.getCudaWhisperStatus?.();
          if (status?.gpuInfo.hasNvidiaGpu && status.gpuInfo.cudaSupported) {
            if (!status.downloaded) results.transcription = true;
          } else {
            const vulkan = await window.electronAPI?.getVulkanWhisperStatus?.();
            if (vulkan?.vulkan.available && !vulkan.downloaded) results.transcription = true;
          }
        } catch {}
      }
      if (offers.intelligence) {
        try {
          const [gpu, vulkan] = await Promise.all([
            window.electronAPI?.detectVulkanGpu?.(),
            window.electronAPI?.getLlamaVulkanStatus?.(),
          ]);
          if (gpu?.available && !vulkan?.downloaded) results.intelligence = offers.intelligence;
        } catch {}
      }
      if (!cancelled) setAvailability(results);
    };
    detect();
    return () => {
      cancelled = true;
    };
  }, [settings, agentAllowedByPolicy, dismissed, settingsOpen, platform]);

  return availability;
}
