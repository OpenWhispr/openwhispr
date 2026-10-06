export type SpeakerStatus = 'provisional' | 'suggested' | 'confirmed' | 'locked';
export type SpeakerLockSource = 'user' | 'diarization' | 'suggestion';

export interface SpeakerState {
  speakerStatus?: SpeakerStatus;
  speakerLocked?: boolean;
  speakerLockSource?: SpeakerLockSource;
  displayName?: string | null;
}

export const SPEAKER_STATUS = {
  PROVISIONAL: 'provisional',
  SUGGESTED: 'suggested',
  CONFIRMED: 'confirmed',
  LOCKED: 'locked',
} as const;

const canonicalStatus = (state: SpeakerState): SpeakerStatus | undefined => {
  if (state.speakerLocked || state.speakerLockSource === 'user') return 'locked';
  switch (state.speakerStatus) {
    case 'provisional':
    case 'suggested':
    case 'confirmed':
    case 'locked':
      return state.speakerStatus;
    default:
      return undefined;
  }
};

export const isLocked = (state: SpeakerState): boolean => canonicalStatus(state) === 'locked';

export const canAutoRelabel = (state: SpeakerState): boolean => !isLocked(state);

const stripUndefined = (obj: SpeakerState): SpeakerState =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as SpeakerState;

const applyUpdate = (
  state: SpeakerState,
  patch: Partial<SpeakerState>,
  status: SpeakerStatus,
): SpeakerState => {
  if (isLocked(state)) {
    return {
      ...state,
      speakerStatus: 'locked',
      speakerLocked: true,
      speakerLockSource: state.speakerLockSource ?? 'user',
    };
  }
  return { ...state, ...stripUndefined(patch as SpeakerState), speakerStatus: status };
};

export const applyProvisional = (
  state: SpeakerState,
  patch: Partial<SpeakerState> = {},
): SpeakerState => applyUpdate(state, patch, 'provisional');

export const applyConfirmed = (
  state: SpeakerState,
  patch: Partial<SpeakerState> = {},
): SpeakerState => applyUpdate(state, patch, 'confirmed');

export const applySuggested = (
  state: SpeakerState,
  patch: Partial<SpeakerState> = {},
): SpeakerState => (isLocked(state) ? state : applyUpdate(state, patch, 'suggested'));

export const lockSpeaker = (
  state: SpeakerState,
  patch: Partial<SpeakerState> = {},
): SpeakerState => ({
  ...state,
  ...stripUndefined(patch as SpeakerState),
  speakerLocked: true,
  speakerStatus: 'locked',
  speakerLockSource: 'user',
});

export const mergeSpeakerState = (existing: SpeakerState, incoming: SpeakerState): SpeakerState =>
  isLocked(existing) ? { ...existing } : { ...existing, ...stripUndefined(incoming) };
