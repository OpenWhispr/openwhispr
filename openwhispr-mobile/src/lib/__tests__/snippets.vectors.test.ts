import vectors from '../../../plugins/keyboard-extension/tests/fixtures/snippet-vectors.json';
import { expandSnippets } from '../snippets';

// The keyboard expands snippets in Swift (plugins/keyboard-extension/ios/SnippetExpander.swift)
// against the same vectors, so the two can't drift apart.
describe('snippet vectors shared with the keyboard', () => {
  it.each(vectors)('$name', ({ text, snippets, expected }) => {
    expect(expandSnippets(text, snippets)).toBe(expected);
  });
});
