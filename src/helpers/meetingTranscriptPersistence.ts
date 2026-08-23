import type { TranscriptSegment } from "../stores/meetingRecordingStore";

// The final transcript is persisted from the store's stop path, not from a
// notes-view effect: a recording can stop without the user driving it
// (auto-end, owner loss) while another view is open, and any persistence keyed
// to a mounted editor would silently drop the tail since the last periodic
// save. Delayed diarization results are handled by the store's #1495 listener.
//
// Main owns the authorization-bound finalization boundary. Renderer persistence
// therefore starts only after main confirms that stop completed successfully;
// a stop overtaken by authorization revocation must never write its captured
// segments or a fallback transcript.
export async function persistFinalTranscriptAroundStop<T>({
  segments,
  serializeSegments,
  persist,
  stop,
  shouldPersist,
  assertAuthorized,
  authorizationChanged,
  fallbackTranscript,
}: {
  segments: TranscriptSegment[];
  serializeSegments: (segments: TranscriptSegment[]) => string;
  persist: (transcript: string) => Promise<void>;
  stop: () => Promise<T>;
  shouldPersist: (result: T) => boolean;
  assertAuthorized: () => void;
  authorizationChanged: Promise<void>;
  fallbackTranscript: () => string;
}): Promise<T> {
  const result = await stop();
  if (!shouldPersist(result)) return result;

  const transcript = segments.length > 0 ? serializeSegments(segments) : fallbackTranscript();
  if (!transcript) return result;

  assertAuthorized();
  const persistence = persist(transcript);
  const persistenceOutcome = await Promise.race([
    persistence.then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error })
    ),
    authorizationChanged.then(() => ({ kind: "authorization-changed" as const })),
  ]);
  if (persistenceOutcome.kind === "authorization-changed") {
    // updateNote's main handler commits synchronously, but its renderer promise
    // may still be pending. Detach that stale completion so revocation does not
    // block stop or admit any renderer state derived from it.
    assertAuthorized();
    return result;
  }
  if (persistenceOutcome.kind === "failed") throw persistenceOutcome.error;
  assertAuthorized();
  return result;
}
