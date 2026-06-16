import type { SystemAudioAccessResult, SystemAudioStrategy } from "../types/electron";
import { getCachedPlatform } from "./platform";

export type RendererSystemAudioStrategy = Extract<SystemAudioStrategy, "loopback">;

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
    };
  }

  return DEFAULT_SYSTEM_AUDIO_ACCESS;
};

export const canManageSystemAudioInApp = ({ mode }: Pick<SystemAudioAccessResult, "mode">) =>
  mode === "native";

export const isRendererSystemAudioStrategy = (
  strategy: SystemAudioStrategy | undefined | null
): strategy is RendererSystemAudioStrategy => strategy === "loopback";

export const getDisplayCaptureModeForStrategy = (
  _strategy: RendererSystemAudioStrategy
): "loopback" | "portal" => "loopback";
