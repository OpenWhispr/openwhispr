import { create } from 'zustand';

interface HandoffState {
  isActive: boolean;
  isCheckingInitialUrl: boolean;
  noSpeechDetected: boolean;
  isTranscribing: boolean;
  setActive: (v: boolean) => void;
  setCheckingInitialUrl: (v: boolean) => void;
  setNoSpeechDetected: (v: boolean) => void;
  setTranscribing: (v: boolean) => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  isActive: false,
  isCheckingInitialUrl: true,
  noSpeechDetected: false,
  isTranscribing: false,
  setActive: (v) => set({ isActive: v }),
  setCheckingInitialUrl: (v) => set({ isCheckingInitialUrl: v }),
  setNoSpeechDetected: (v) => set({ noSpeechDetected: v }),
  setTranscribing: (v) => set({ isTranscribing: v }),
}));
