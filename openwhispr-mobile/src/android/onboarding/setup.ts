import { useConfigStore } from '@/store/useConfigStore';
import { modelSupported } from '../models';

export const SPEECH = 'parakeet-v3' as const;
export const CLEANUP = 'qwen-small' as const;

export function privateSupported(): boolean {
  return modelSupported(SPEECH) && modelSupported(CLEANUP);
}

// Everything on the phone: on-device speech and cleanup, no cloud backup.
export async function applyPrivateConfig(): Promise<void> {
  await useConfigStore.getState().updateConfig({
    defaultMode: 'private',
    cleanupEnabled: true,
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
  const saved = useConfigStore.getState().config?.inference ?? {};
  const inference = Object.fromEntries(
    Object.entries(saved).filter(([, selection]) => selection?.mode !== 'local'),
  );
  await useConfigStore.getState().updateConfig({ defaultMode: 'cloud', inference });
}
