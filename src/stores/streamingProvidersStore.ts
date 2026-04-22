import { create } from "zustand";
import logger from "../utils/logger";

export interface NoteRecordingProviderModel {
  id: string;
  name: string;
  default?: boolean;
}

export interface NoteRecordingProvider {
  id: string;
  name: string;
  models: NoteRecordingProviderModel[];
}

interface StreamingProvidersState {
  providers: NoteRecordingProvider[] | null;
}

export const useStreamingProvidersStore = create<StreamingProvidersState>()(() => ({
  providers: null,
}));

let inFlight: Promise<NoteRecordingProvider[] | null> | null = null;

export async function fetchProviders(): Promise<NoteRecordingProvider[] | null> {
  if (inFlight) return inFlight;
  if (!window.electronAPI?.getNoteRecordingConfig) return null;

  inFlight = (async () => {
    try {
      const data = await window.electronAPI.getNoteRecordingConfig!();
      if (!data?.success) {
        throw new Error("Note recording config unavailable");
      }
      const providers = Array.isArray(data.providers) ? data.providers : [];
      useStreamingProvidersStore.setState({ providers });
      return providers;
    } catch (err) {
      logger.warn("Failed to fetch note recording providers", err, "streamingProviders");
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function getDefaultProvider(): NoteRecordingProvider | null {
  return useStreamingProvidersStore.getState().providers?.[0] ?? null;
}

export function useStreamingProviders(): NoteRecordingProvider[] | null {
  return useStreamingProvidersStore((state) => state.providers);
}
