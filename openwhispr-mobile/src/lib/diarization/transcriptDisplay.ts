import type { Segment, Speaker } from '@/data/types';

export interface TranscriptBlock {
  id: string;
  speakerId: number | null;
  speakerLabel: string | null;
  speakerName: string;
  speakerColor: string;
  speakerStatus: Speaker['speakerStatus'] | null;
  startMs: number;
  endMs: number;
  timestamp: string;
  text: string;
  segmentIds: number[];
}

export interface FormatTranscriptInput {
  title?: string | null;
  segments?: Segment[];
  speakers?: Speaker[];
  blocks?: TranscriptBlock[];
  suppressUnlabeledSpeakerNames?: boolean;
}

const SPEAKER_PALETTE = [
  '#007AFF',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#FF2D55',
  '#5AC8FA',
  '#5856D6',
  '#FFCC00',
];

const UNKNOWN_SPEAKER = 'Unknown speaker';
const UNKNOWN_COLOR = '#8E8E93';

export const formatTranscriptTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export const getSpeakerDisplayName = (
  speaker: Pick<Speaker, 'displayName' | 'sortOrder' | 'speakerStatus'> | null | undefined,
  fallbackIndex: number,
): string => {
  const name = speaker?.displayName?.trim();
  if (name) return speaker?.speakerStatus === 'suggested' ? `${name}?` : name;
  const index = speaker?.sortOrder ?? fallbackIndex;
  return `Speaker ${index + 1}`;
};

export const getSpeakerDisplayColor = (
  speaker: Pick<Speaker, 'color' | 'sortOrder'> | null | undefined,
  fallbackIndex: number,
): string => {
  const color = speaker?.color?.trim();
  if (color) return color;
  const index = speaker?.sortOrder ?? fallbackIndex;
  return SPEAKER_PALETTE[Math.abs(index) % SPEAKER_PALETTE.length];
};

const compareSegments = (a: Segment, b: Segment): number => {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return a.id - b.id;
};

const normalizedText = (text: string): string => text.trim().replace(/\s+/g, ' ');

const joinText = (left: string, right: string): string =>
  [left, right].map(normalizedText).filter(Boolean).join(' ');

export const groupTranscriptSegments = (
  segments: Segment[],
  speakers: Speaker[],
): TranscriptBlock[] => {
  const speakerEntries = speakers.map((speaker, index) => ({
    speaker,
    index,
    name: getSpeakerDisplayName(speaker, index),
    color: getSpeakerDisplayColor(speaker, index),
  }));
  const speakerMap = new Map(speakerEntries.map((entry) => [entry.speaker.speakerLabel, entry]));

  return [...segments].sort(compareSegments).reduce<TranscriptBlock[]>((blocks, segment) => {
    const entry = segment.speakerLabel ? speakerMap.get(segment.speakerLabel) : undefined;
    const speakerName = entry?.name ?? UNKNOWN_SPEAKER;
    const speakerColor = entry?.color ?? UNKNOWN_COLOR;
    const text = normalizedText(segment.text);
    if (!text) return blocks;

    const previous = blocks[blocks.length - 1];
    if (previous?.speakerName === speakerName) {
      previous.text = joinText(previous.text, text);
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      previous.segmentIds.push(segment.id);
      return blocks;
    }

    blocks.push({
      id: `segment-${segment.id}`,
      speakerId: entry?.speaker.id ?? null,
      speakerLabel: segment.speakerLabel ?? null,
      speakerName,
      speakerColor,
      speakerStatus: entry?.speaker.speakerStatus ?? null,
      startMs: segment.startMs,
      endMs: segment.endMs,
      timestamp: formatTranscriptTimestamp(segment.startMs),
      text,
      segmentIds: [segment.id],
    });
    return blocks;
  }, []);
};

export const formatTranscriptForExport = (input: FormatTranscriptInput): string => {
  const blocks =
    input.blocks ?? groupTranscriptSegments(input.segments ?? [], input.speakers ?? []);
  const title = input.title?.trim();
  const lines = blocks
    .map((block) => ({
      timestamp: block.timestamp,
      hasSpeaker: block.speakerId !== null,
      speakerName: block.speakerName.trim(),
      text: block.text.trim(),
    }))
    .filter((block) => block.text)
    .map((block) => {
      const speakerPrefix =
        input.suppressUnlabeledSpeakerNames && !block.hasSpeaker ? '' : `${block.speakerName}: `;
      return `[${block.timestamp}] ${speakerPrefix}${block.text}`;
    });

  if (!title) return lines.join('\n\n');
  if (lines.length === 0) return title;
  return [title, ...lines].join('\n\n');
};
