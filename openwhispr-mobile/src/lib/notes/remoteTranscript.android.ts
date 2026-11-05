// The explicit extension selects the unchanged implementation, not this Android adapter.
const shared = require('./remoteTranscript.ts') as typeof import('./remoteTranscript');

export type { ParsedSegment, ParsedSpeaker, ParsedTranscript } from './remoteTranscript';
export const MIC_SPEAKER_LABEL = shared.MIC_SPEAKER_LABEL;

export function parseRemoteTranscript(
  raw: string,
): ReturnType<typeof shared.parseRemoteTranscript> {
  try {
    const items: unknown = JSON.parse(raw);
    // Returning null makes the repository keep saved speech instead of replacing
    // it with blank rows when a malformed transcript arrives.
    if (
      !Array.isArray(items) ||
      items.some(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          Array.isArray(item) ||
          typeof item.text !== 'string',
      )
    )
      return null;
  } catch {
    return null;
  }
  return shared.parseRemoteTranscript(raw);
}

export function serializeSegmentsForSync(
  ...[segments, speakers, originalRaw]: Parameters<typeof shared.serializeSegmentsForSync>
): string {
  return shared.serializeSegmentsForSync(
    segments,
    speakers,
    originalRaw && parseRemoteTranscript(originalRaw) ? originalRaw : undefined,
  );
}
