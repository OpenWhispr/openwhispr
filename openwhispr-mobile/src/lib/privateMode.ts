import { Alert } from 'react-native';
import { router } from 'expo-router';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';

export type PrivateModeStatus = 'ready' | 'missing' | 'unavailable';

export interface PrivateModeReadiness {
  status: PrivateModeStatus;
  /** Display label of the engine the user's language selection routes to (e.g. "Parakeet v2"). */
  modelName: string;
}

/**
 * Whether private mode can transcribe right now: the engine the user's language selection
 * routes to (Parakeet v2/v3 or Whisper) has its model downloaded. The legacy modelName
 * parameter is accepted for call-site compatibility but ignored — readiness is language-aware.
 */
export async function getPrivateModeReadiness(
  _legacyModelName?: string,
): Promise<PrivateModeReadiness> {
  const modelName = LocalTranscriptionService.preferredEngineDescriptor().label;

  if (!LocalTranscriptionService.isAvailable()) {
    return { status: 'unavailable', modelName };
  }

  const ready = await LocalTranscriptionService.isReadyForLanguage();
  return { status: ready ? 'ready' : 'missing', modelName };
}

export function getPrivateModeUnavailableMessage(): string {
  return 'Build OpenWhispr with native modules enabled before using on-device transcription.';
}

// Private mode with no on-device model. We never upload automatically — the
// user explicitly chooses to download the model or send this one recording to
// the cloud.
export function promptLocalModelFallback(onUseCloudOnce: () => void): void {
  Alert.alert(
    'On-device model unavailable',
    "The model for private dictation isn't downloaded, so this recording can't be transcribed on your device. Send it to the cloud instead?",
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Download Model', onPress: () => router.push('/(account)/model-download') },
      { text: 'Use Cloud Once', onPress: onUseCloudOnce },
    ],
  );
}
