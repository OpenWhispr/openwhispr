import { create } from "zustand";
import logger from "../utils/logger";
import type {
  NoteRecordingConfigFailure,
  NoteRecordingConfigResult,
  NoteRecordingProvider,
  NoteRecordingProviderModel,
} from "../types/electron";

export type { NoteRecordingProvider, NoteRecordingProviderModel };

interface StreamingProvidersState {
  providers: NoteRecordingProvider[] | null;
}

export const useStreamingProvidersStore = create<StreamingProvidersState>()(() => ({
  providers: null,
}));

let inFlight: Promise<NoteRecordingConfigResult | null> | null = null;

export async function fetchProviders(): Promise<NoteRecordingConfigResult | null> {
  if (inFlight) return inFlight;
  if (!window.electronAPI?.getNoteRecordingConfig) return null;

  inFlight = (async () => {
    try {
      const data = await window.electronAPI.getNoteRecordingConfig!();
      if (!data) return null;
      if (data.success === false) {
        logger.warn("Failed to fetch note recording providers", data, "streamingProviders");
        return data;
      }
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const result = { ...data, providers };
      useStreamingProvidersStore.setState({ providers });
      return result;
    } catch (err) {
      const failure: NoteRecordingConfigFailure = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      logger.warn("Failed to fetch note recording providers", err, "streamingProviders");
      return failure;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
