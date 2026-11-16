import { PermissionsAndroid } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { createAndroidJob, processAndroidAudio } from '../pipeline';

export type MicAccess = 'granted' | 'denied' | 'blocked';

// Android's own dialog ("While using the app / Only this time / Don't allow").
export async function requestMicrophone(): Promise<MicAccess> {
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) return 'granted';
  const result = await PermissionsAndroid.request(permission);
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
}

// The practice bubble records inside the app, so it works before the overlay and
// accessibility switches are on, and runs the same pipeline the real bubble uses.
export class PracticeRecorder {
  private recording = false;
  private controller: AbortController | null = null;

  async start(): Promise<void> {
    if (!AndroidDictation) throw new Error('Dictation is not available on this device.');
    this.controller?.abort();
    await AndroidDictation.startRecording();
    this.recording = true;
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    if (!this.recording || !AndroidDictation) return;
    this.recording = false;
    const audio = await AndroidDictation.stopRecording(true).catch(() => null);
    if (audio?.uri) await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => {});
  }

  async finish(): Promise<string> {
    if (!AndroidDictation) throw new Error('Dictation is not available on this device.');
    this.recording = false;
    const audio = await AndroidDictation.stopRecording(false);
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await processAndroidAudio(
        audio,
        createAndroidJob('dictate'),
        controller.signal,
        () => {},
      );
    } finally {
      if (this.controller === controller) this.controller = null;
      await FileSystem.deleteAsync(audio.uri, { idempotent: true }).catch(() => {});
    }
  }

  get active(): boolean {
    return this.recording;
  }
}
