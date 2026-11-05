export type TranscriptScope = { owner: string; key: string; revision: number } | null;

export function captureTranscriptScope(): TranscriptScope {
  return null;
}

export function isTranscriptScopeCurrent(scope: TranscriptScope): boolean {
  return scope === null;
}

export function observeTranscriptScope(_change: () => void): () => void {
  return () => {};
}
