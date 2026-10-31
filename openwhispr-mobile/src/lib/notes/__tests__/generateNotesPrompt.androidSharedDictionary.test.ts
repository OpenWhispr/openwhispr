import { buildActionSystemPrompt } from '../generateNotesPrompt';
import { DESKTOP_DEFAULT_NOTE_SYSTEM_PROMPT } from '../desktopDefaultNotesPrompt';
import { sharedDictionaryHint } from '@/lib/sharedDictionaryHints';

it('keeps the desktop notes contract while appending personal and shared spellings', () => {
  const prompt = buildActionSystemPrompt({
    actionPrompt: 'Saved mobile default',
    inputKind: 'plain-note',
    isDefaultGenerateNotesAction: true,
    desktopDefaultNotes: true,
    customDictionary: [' Piha ', 'Piha'],
    sharedDictionary: [' Acme ', 'Acme', 'Gizmo'],
  });

  expect(prompt).toBe(
    DESKTOP_DEFAULT_NOTE_SYSTEM_PROMPT +
      '\n\nCustom Dictionary (use these exact spellings when they appear in the text): Piha' +
      '\n\n' +
      sharedDictionaryHint(['Acme', 'Gizmo']),
  );
});

it('retains JSON meeting content rules and shared hints without markdown formatting rules', () => {
  const prompt = buildActionSystemPrompt({
    actionPrompt: 'Return the supplied JSON schema.',
    inputKind: 'meeting-transcript',
    isDefaultGenerateNotesAction: true,
    desktopDefaultNotes: true,
    outputFormat: 'json',
    sharedDictionary: ['Acme'],
  });

  expect(prompt).toContain('Produce concise structured meeting notes.');
  expect(prompt).toContain('Do not infer ownership from the attendee list alone.');
  expect(prompt).toContain('Return the supplied JSON schema.');
  expect(prompt).toContain(sharedDictionaryHint(['Acme']));
  expect(prompt).not.toContain('Use clear section headings:');
});
