export type ActivationMode = "tap" | "push" | "hybrid";
export const ACTIVATION_MODES: readonly ActivationMode[];
export const HYBRID_TAP_THRESHOLD_MS: number;
export function normalizeActivationMode(mode: unknown): ActivationMode;
export function usesKeyRelease(mode: unknown): boolean;
export function toHotkeyRegistrationMode(mode: unknown): "tap" | "push";
export function resolveDictationPress(input: {
  mode: unknown;
  isRecording?: boolean;
}): "toggle" | "stop" | "hold";
export function resolveDictationRelease(input: {
  mode: unknown;
  heldMs: number;
  isRecording?: boolean;
  force?: boolean;
  thresholdMs?: number;
}): "latch" | "stop" | "cancel";
