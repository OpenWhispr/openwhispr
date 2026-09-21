import { buildNoteShareContent } from '../noteExport';

describe('buildNoteShareContent', () => {
  const base = {
    viewMode: 'original' as const,
    enhancedContent: null,
    usesSegmentTranscript: false,
    transcript: '[00:12] Alice: Hello there\n\n[00:15] Bob: Hi',
    content: 'Raw note body',
  };

  it('shares the enhanced notes when viewing the enhanced tab', () => {
    expect(
      buildNoteShareContent({
        ...base,
        viewMode: 'enhanced',
        enhancedContent: '## Summary\n\n- Decision made',
      }),
    ).toBe('## Summary\n\n- Decision made');
  });

  it('shares the enhanced notes for meeting notes too', () => {
    expect(
      buildNoteShareContent({
        ...base,
        viewMode: 'enhanced',
        enhancedContent: '## Meeting notes',
        usesSegmentTranscript: true,
      }),
    ).toBe('## Meeting notes');
  });

  it('shares the formatted transcript when viewing the transcript of a meeting note', () => {
    const shared = buildNoteShareContent({ ...base, usesSegmentTranscript: true });
    expect(shared).toBe(base.transcript);
    expect(shared).not.toContain('Raw notes captured during the meeting');
    expect(shared).not.toContain('Meeting transcript:');
  });

  it('shares the note body for plain notes without enhancement', () => {
    expect(buildNoteShareContent(base)).toBe('Raw note body');
  });

  it('falls back to the original content when enhanced view has no enhanced content', () => {
    expect(buildNoteShareContent({ ...base, viewMode: 'enhanced' })).toBe('Raw note body');
  });
});
