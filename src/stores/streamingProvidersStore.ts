import { create } from "zustand";
import { getStreamingTranscriptionProviders } from "../models/ModelRegistry";

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

// The realtime-capable provider catalog comes from the bundled model registry —
// every provider here is BYOK, so there is no server to ask.
function readProviders(): NoteRecordingProvider[] {
  return getStreamingTranscriptionProviders().map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.map((m) => ({ id: m.id, name: m.name })),
  }));
}

export const useStreamingProvidersStore = create<StreamingProvidersState>()(() => ({
  providers: readProviders(),
}));

export async function fetchProviders(): Promise<NoteRecordingProvider[]> {
  const providers = readProviders();
  useStreamingProvidersStore.setState({ providers });
  return providers;
}
