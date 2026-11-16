import { buildNoteShareContent } from '../noteExport';

describe('buildNoteShareContent', () => {
  const base = {
    viewMode: 'notes' as const,
    enhancedContent: null,
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

  it('shares the formatted transcript when viewing the transcript', () => {
    const shared = buildNoteShareContent({ ...base, viewMode: 'transcript' });
    expect(shared).toBe(base.transcript);
    expect(shared).not.toContain('Raw notes captured during the meeting');
    expect(shared).not.toContain('Meeting transcript:');
  });

  it('shares the note body on My notes', () => {
    expect(buildNoteShareContent(base)).toBe('Raw note body');
  });

  it('shares nothing but the title from an empty tab, as the tab shows', () => {
    expect(buildNoteShareContent({ ...base, viewMode: 'enhanced' })).toBe('');
    expect(buildNoteShareContent({ ...base, viewMode: 'transcript', transcript: '' })).toBe('');
  });
});
