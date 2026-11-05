import { create } from 'zustand';
import type { Transcript } from '@/types';
import { createAndroidTranscriptLifecycle } from '@/android/transcriptStoreLifecycle';
import {
  createTranscriptState,
  type TranscriptState,
  type FailedTranscriptInput as BaseFailedTranscriptInput,
} from './createTranscriptStore';

export { createTranscriptId } from './createTranscriptStore';
export type { AddTranscriptInput } from './createTranscriptStore';
export type FailedTranscriptInput = BaseFailedTranscriptInput & { clientTranscriptionId?: string };
interface AndroidTranscriptState extends TranscriptState {
  reset: () => void;
  retryTranscript: (id: string, signal?: AbortSignal) => Promise<Transcript>;
  addFailedTranscript: (input: FailedTranscriptInput) => Promise<void>;
}
export const useTranscriptStore = create<AndroidTranscriptState>((set, get) =>
  createTranscriptState(set, get, createAndroidTranscriptLifecycle),
);
