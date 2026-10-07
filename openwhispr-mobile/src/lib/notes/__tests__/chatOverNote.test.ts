import { boundChatContext, buildNoteChatContext } from '@/lib/notes/chatOverNote';

describe('buildNoteChatContext', () => {
  it('returns the source text unchanged when there are no generated notes', () => {
    expect(buildNoteChatContext({ generatedNotes: null, sourceText: '  Raw notes  ' })).toBe(
      'Raw notes',
    );
  });

  it('puts the note ahead of the generated notes', () => {
    const context = buildNoteChatContext({
      generatedNotes: '## Action items\n- Ship it',
      sourceText: 'Meeting transcript:\n[0:00] Speaker 1: Ship it.',
    });

    expect(context).toBe(
      'Note content:\nMeeting transcript:\n[0:00] Speaker 1: Ship it.\n\n' +
        'Generated notes:\n## Action items\n- Ship it',
    );
  });

  it('still gives context when only generated notes exist', () => {
    expect(buildNoteChatContext({ generatedNotes: 'Summary', sourceText: '   ' })).toBe(
      'Generated notes:\nSummary',
    );
  });

  it('keeps the typed notes and the generated notes when a long transcript is truncated', () => {
    const context = buildNoteChatContext({
      generatedNotes: 'Decision: launch Friday',
      sourceText: `Raw notes captured during the meeting:\nCall the vendor\n\n${'x'.repeat(40_000)}`,
    });

    const { text } = boundChatContext(context);
    expect(text).toContain('Call the vendor');
    expect(text).toContain('Decision: launch Friday');
  });

  it('keeps the typed notes and the start of long generated notes', () => {
    const context = buildNoteChatContext({
      generatedNotes: `## Summary\nLaunch Friday\n\n${'y'.repeat(20_000)}`,
      sourceText: `Raw notes captured during the meeting:\nCall the vendor\n\n${'x'.repeat(20_000)}`,
    });

    const { text } = boundChatContext(context);
    expect(text).toContain('Call the vendor');
    expect(text).toContain('## Summary\nLaunch Friday');
  });

  it('leaves long generated notes whole when everything fits', () => {
    const generated = 'y'.repeat(10_000);
    expect(buildNoteChatContext({ generatedNotes: generated, sourceText: 'Short note' })).toContain(
      generated,
    );
  });

  it('caps the generated notes when their labels are what push the context over the limit', () => {
    // Exactly 24,000 characters of text, plus the "Note content:" and "Generated notes:" labels.
    const context = buildNoteChatContext({
      generatedNotes: `## Summary\n${'y'.repeat(19_989)}`,
      sourceText: 'x'.repeat(4_000),
    });

    expect(context).toContain('[...rest of the generated notes omitted...]');
    expect(boundChatContext(context).truncated).toBe(false);
  });
});
