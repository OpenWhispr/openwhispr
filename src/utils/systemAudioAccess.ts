import type { SystemAudioAccessResult, SystemAudioStrategy } from "../types/electron";
import { getCachedPlatform } from "./platform";

export type RendererSystemAudioStrategy = Extract<
  SystemAudioStrategy,
  "loopback" | "browser-portal"
>;

export const DEFAULT_SYSTEM_AUDIO_ACCESS: SystemAudioAccessResult = {
  granted: false,
  status: "unsupported",
  mode: "unsupported",
  supportsPersistentGrant: false,
  supportsPersistentPortalGrant: false,
  supportsNativeCapture: false,
  supportsOnboardingGrant: false,
  requiresRuntimeSharePrompt: false,
  strategy: "unsupported",
  restoreTokenAvailable: false,
  portalVersion: null,
};

export const getFallbackSystemAudioAccess = (
  platform = getCachedPlatform()
): SystemAudioAccessResult => {
  if (platform === "win32") {
    return {
      ...DEFAULT_SYSTEM_AUDIO_ACCESS,
      granted: true,
      status: "granted",
      mode: "loopback",
      strategy: "loopback",
    };
  }

  if (platform === "linux") {
    return {
      ...DEFAULT_SYSTEM_AUDIO_ACCESS,
      status: "unknown",
      mode: "portal",
      requiresRuntimeSharePrompt: true,
      strategy: "browser-portal",
    };
  }

  return DEFAULT_SYSTEM_AUDIO_ACCESS;
};

export const canManageSystemAudioInApp = ({
  mode,
  supportsOnboardingGrant,
}: Pick<SystemAudioAccessResult, "mode" | "supportsOnboardingGrant">) =>
  mode === "native" || (mode === "portal" && !!supportsOnboardingGrant);

export const isRendererSystemAudioStrategy = (
  strategy: SystemAudioStrategy | undefined | null
): strategy is RendererSystemAudioStrategy =>
  strategy === "loopback" || strategy === "browser-portal";

export const getDisplayCaptureModeForStrategy = (
  strategy: RendererSystemAudioStrategy
): "loopback" | "portal" => (strategy === "loopback" ? "loopback" : "portal");
