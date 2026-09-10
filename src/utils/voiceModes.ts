import type { DictationTargetApp } from "../types/electron";

export interface VoiceMode {
  id: string;
  name: string;
  /** App names, bundle ids, exe names, or window classes this mode applies to. */
  apps: string[];
  instructions: string;
}

/** What the prompt needs from a matched mode. */
export interface VoiceModePrompt {
  appName: string;
  instructions: string;
}

// Case-insensitive, and Windows exe names drop their extension so "Slack"
// matches "slack.exe".
export function normalizeAppIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

export function resolveVoiceMode(
  modes: VoiceMode[],
  target: DictationTargetApp | null | undefined
): VoiceModePrompt | null {
  if (!target) return null;
  const identifiers = new Set(
    [target.name, target.bundleId, target.windowClass]
      .filter((value): value is string => !!value)
      .map(normalizeAppIdentifier)
  );
  if (identifiers.size === 0) return null;

  const mode = modes.find(
    (candidate) =>
      candidate.instructions.trim() &&
      candidate.apps.some((app) => identifiers.has(normalizeAppIdentifier(app)))
  );
  if (!mode) return null;
  return { appName: target.name || mode.apps[0], instructions: mode.instructions.trim() };
}
