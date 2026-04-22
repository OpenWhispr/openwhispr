import { create } from "zustand";
import { OPENWHISPR_API_URL } from "../config/constants";
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
  if (!OPENWHISPR_API_URL) return null;

  inFlight = (async () => {
    try {
      const res = await fetch(`${OPENWHISPR_API_URL}/api/note-recording-config`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }
      const data = (await res.json()) as { providers?: NoteRecordingProvider[] };
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
