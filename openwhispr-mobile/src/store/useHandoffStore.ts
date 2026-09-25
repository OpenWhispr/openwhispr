import { create } from 'zustand';

/** `returning` until the native return reports back; `manual` once the user may need to act. */
export type HandoffReturnState = 'returning' | 'manual';

interface HandoffState {
  isActive: boolean;
  isCheckingInitialUrl: boolean;
  noSpeechDetected: boolean;
  isTranscribing: boolean;
  returnState: HandoffReturnState;
  returnHostName: string | null;
  setActive: (v: boolean) => void;
  setCheckingInitialUrl: (v: boolean) => void;
  setNoSpeechDetected: (v: boolean) => void;
  setTranscribing: (v: boolean) => void;
  setReturnState: (state: HandoffReturnState, hostName: string | null) => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  isActive: false,
  isCheckingInitialUrl: true,
  noSpeechDetected: false,
  isTranscribing: false,
  returnState: 'returning',
  returnHostName: null,
  setActive: (v) =>
    set(v ? { isActive: true, returnState: 'returning', returnHostName: null } : { isActive: false }),
  setCheckingInitialUrl: (v) => set({ isCheckingInitialUrl: v }),
  setNoSpeechDetected: (v) => set({ noSpeechDetected: v }),
  setTranscribing: (v) => set({ isTranscribing: v }),
  setReturnState: (returnState, returnHostName) => set({ returnState, returnHostName }),
}));
