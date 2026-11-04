import { create } from 'zustand';
import { createTranscriptState, type TranscriptState } from './createTranscriptStore';
import { createDefaultTranscriptLifecycle } from './transcriptStoreLifecycle';

export { createTranscriptId } from './createTranscriptStore';
export type { AddTranscriptInput, FailedTranscriptInput } from './createTranscriptStore';
export const useTranscriptStore = create<TranscriptState>((set, get) =>
  createTranscriptState(set, get, createDefaultTranscriptLifecycle),
);
