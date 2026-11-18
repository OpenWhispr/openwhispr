import { parseRemoteTranscript, serializeSegmentsForSync } from '../remoteTranscript.android';
import type { Segment, Speaker } from '@/data/types';

const shared = require('../remoteTranscript.ts') as typeof import('../remoteTranscript');

it.each(['[[]]', '[{}]', '[{"text":7}]', '[{"text":"valid line","source":"mic"},[]]'])(
  'protects Android from damaged transcript entries without changing the default parser: %s',
  (raw) => {
    expect(shared.parseRemoteTranscript(raw)).not.toBeNull();
    expect(parseRemoteTranscript(raw)).toBeNull();
  },
);

it.each([
  '[]',
  '[{"text":""}]',
  '[{"text":"Hello","source":"mic","timestamp":1000,"recorderName":"Kept"}]',
])(
  'keeps valid parsing and serialization compatible with the default implementation: %s',
  (raw) => {
    const parsed = parseRemoteTranscript(raw)!;
    expect(parsed).toEqual(shared.parseRemoteTranscript(raw));
    const segments = parsed.segments.map((segment, id) => ({
      ...segment,
      id,
      noteId: 1,
    })) as Segment[];
    const speakers = parsed.speakers.map((speaker, id) => ({
      ...speaker,
      id,
      noteId: 1,
    })) as Speaker[];
    expect(serializeSegmentsForSync(segments, speakers, raw)).toBe(raw);
  },
);

it('does not reuse malformed original entries when Android serializes retained rows', () => {
  const segments = [
    { id: 1, noteId: 1, text: '', startMs: 0, endMs: 0, sortOrder: 0, speakerLabel: null },
  ] as Segment[];
  expect(serializeSegmentsForSync(segments, [], '[{}]')).toBe('[{"text":"","source":"mic"}]');
  expect(shared.serializeSegmentsForSync(segments, [], '[{}]')).toBe('[{}]');
});
