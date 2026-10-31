import { Platform } from 'react-native';

export type TranscriptScope = { owner: string; key: string; revision: number } | null;

export function captureTranscriptScope(): TranscriptScope {
  if (Platform.OS !== 'android') return null;
  const { useAccountData } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  const state = useAccountData.getState();
  if (!state.owner || state.blocked || state.error)
    throw new Error('Local account data is unavailable.');
  // The database namespace survives linking an anonymous account to a signed-in account.
  return {
    owner: state.owner,
    key: `history:${state.audioNamespace || 'original'}`,
    revision: state.revision,
  };
}

export function isTranscriptScopeCurrent(scope: TranscriptScope): boolean {
  try {
    const current = captureTranscriptScope();
    return scope === null
      ? current === null
      : current?.owner === scope.owner && current.revision === scope.revision;
  } catch {
    return false;
  }
}

export function observeTranscriptScope(change: () => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const { useAccountData } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  return useAccountData.subscribe((state, previous) => {
    if (
      state.owner !== previous.owner ||
      state.revision !== previous.revision ||
      state.blocked !== previous.blocked ||
      state.error !== previous.error
    )
      change();
  });
}
