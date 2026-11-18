import { randomUUID } from '@/lib/uuid';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation, dictationEvents } from '../../modules/android-dictation/src';
import { meetingAudioContext, meetingAudioDirectory } from '@/lib/meetingAudioStorage';

/** A recording owns one durable note file. Permission is checked before the note is created. */
export class LocalMeetingRecorder {
  readonly uri: string;
  readonly captureId = randomUUID();
  private readonly audio = meetingAudioContext();
  private subscriptions: { remove(): void }[] = [];
  private starting: Promise<void> | null = null;
  private stopping: Promise<string> | null = null;
  private closed = false;
  private notified = false;
  constructor(
    readonly noteId: number,
    private readonly onStopped: (error?: Error) => void,
  ) {
    if (
      !Number.isInteger(noteId) ||
      noteId <= 0 ||
      noteId > 2147483647 ||
      !FileSystem.documentDirectory
    )
      throw new Error('Invalid meeting note.');
    this.uri = `${meetingAudioDirectory(this.audio.namespace)}meeting-${noteId}.wav`;
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.closed) return Promise.reject(this.cancelled());
    if (!this.audio.isCurrent()) return Promise.reject(this.cancelled());
    if (!AndroidDictation?.startLocalMeeting || !dictationEvents)
      return Promise.reject(new Error('Local meeting capture unavailable.'));
    const notify = (noteId: number, captureId: string, error?: Error) => {
      if (noteId !== this.noteId || captureId !== this.captureId || this.closed || this.notified)
        return;
      this.notified = true;
      this.onStopped(error);
    };
    this.subscriptions = [
      dictationEvents.addListener('local-meeting-stopped', ({ noteId, captureId }) =>
        notify(noteId, captureId),
      ),
      dictationEvents.addListener('local-meeting-error', ({ noteId, captureId, message }) =>
        notify(noteId, captureId, new Error(message)),
      ),
    ];
    this.starting = this.invoke(() =>
      AndroidDictation!.startLocalMeeting(this.noteId, this.captureId, this.audio.namespace),
    )
      .then(() => {
        if (this.closed) throw this.cancelled();
      })
      .catch(async (error: unknown) => {
        await this.stop().catch(() => undefined);
        throw error;
      });
    return this.starting;
  }
  stop(): Promise<string> {
    this.closed = true;
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
    this.stopping ??= this.invoke(() =>
      AndroidDictation?.stopLocalMeeting?.(this.noteId, this.captureId),
    ).then(() => this.uri);
    return this.stopping;
  }
  private invoke(operation: () => Promise<void> | undefined): Promise<void> {
    // Invoke immediately, but normalize synchronous bridge failures into rejections.
    return new Promise((resolve) => resolve(operation()));
  }
  private cancelled(): Error {
    return Object.assign(new Error('Meeting recording cancelled.'), { name: 'AbortError' });
  }
}
