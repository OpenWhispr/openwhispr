import { useConfigStore } from '@/store/useConfigStore';
import { modelSupported } from '../models';
import { setBubbleAssistant } from '../settings/bubbleAppearance';

export const SPEECH = 'parakeet-v3' as const;
export const CLEANUP = 'qwen-small' as const;

export function privateSupported(): boolean {
  return modelSupported(SPEECH) && modelSupported(CLEANUP);
}

/**
 * Everything on the phone, no cloud backup. Only what "Set up your device" added is on: cleanup
 * runs only when Cleanup was added, and holding the bubble opens its menu (Assistant, Translate,
 * Edit selection) only when the Assistant was added. Speaker names need their model, which
 * downloads by itself at launch. Settings › Processing turns each on later and downloads it there.
 */
export async function applyPrivateConfig(
  choices: { cleanup: boolean; assistant: boolean } = { cleanup: true, assistant: true },
): Promise<void> {
  // Without the Assistant, Settings › Bubble › Assistant is off: holding the bubble is hold to talk.
  setBubbleAssistant(choices.assistant);
  await useConfigStore.getState().updateConfig({
    defaultMode: 'private',
    cleanupEnabled: choices.cleanup,
    cloudBackupEnabled: false,
    androidSpeechModel: SPEECH,
    androidTextModel: CLEANUP,
    inference: {
      dictation: { mode: 'local' },
      cleanup: { mode: 'local' },
      notes: { mode: 'local' },
      agent: { mode: 'local' },
    },
  });
}

// Back to Cloud: drop only the on-device picks, so a provider someone chose in Settings stays.
export async function applyCloudConfig(): Promise<void> {
  // An On device setup that skipped the Assistant turned it off; Cloud has it.
  setBubbleAssistant(true);
  const saved = useConfigStore.getState().config?.inference ?? {};
  const inference = Object.fromEntries(
    Object.entries(saved).filter(([, selection]) => selection?.mode !== 'local'),
  );
  await useConfigStore.getState().updateConfig({ defaultMode: 'cloud', inference });
}
