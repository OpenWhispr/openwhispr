import vectors from '../../../plugins/keyboard-extension/tests/fixtures/snippet-vectors.json';
import { expandSnippets } from '../snippets';

// The keyboard expands snippets in Swift (plugins/keyboard-extension/ios/SnippetExpander.swift)
// against the same vectors, so the two can't drift apart. A vector with variables names its
// clock as [year, month, day, hour, minute] in local time, and its locale.
describe('snippet vectors shared with the keyboard', () => {
  it.each(vectors)('$name', ({ text, snippets, expected, now, locale }) => {
    const context = now
      ? { now: new Date(now[0], now[1] - 1, now[2], now[3], now[4]), locale }
      : {};
    expect(expandSnippets(text, snippets, context)).toBe(expected);
  });
});
