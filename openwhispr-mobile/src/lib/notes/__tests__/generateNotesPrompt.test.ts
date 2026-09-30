import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt';

describe('buildActionSystemPrompt', () => {
  it('keeps calendar participants context-only for default meeting notes generation', () => {
    const prompt = buildActionSystemPrompt({
      actionPrompt: 'Transform this meeting into notes.',
      inputKind: 'meeting-transcript',
      isDefaultGenerateNotesAction: true,
    });

    expect(prompt).toContain('Do NOT include any preamble');
    expect(prompt).toContain('no attendee list');
    expect(prompt).toContain('Do NOT list or guess participant names');
    expect(prompt).toContain(
      'Use calendar participants only to interpret explicit speaker references or action ownership',
    );
    expect(prompt).toContain(
      'Keep clear actions from unlabeled lines, but do not assign them an owner.',
    );
    expect(prompt).toContain('Never output "Unknown speaker" or any equivalent placeholder');
    expect(prompt).toContain('Do not infer ownership from the attendee list alone');
    expect(prompt).toContain('Do not list attendees just because they were provided.');
  });
});
