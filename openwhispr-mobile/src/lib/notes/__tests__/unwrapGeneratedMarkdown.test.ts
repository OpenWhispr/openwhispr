import { unwrapGeneratedMarkdown } from '../unwrapGeneratedMarkdown';

describe('generated Markdown wrappers', () => {
  it.each([
    ['```markdown\n# Summary\n\n- Ship Friday\n\n```', '# Summary\n\n- Ship Friday'],
    [' \n~~~MD\r\n\r\n## Summary\r\n~~~\n', '## Summary'],
    [
      '````markdown\nExample:\n```js\nconst value = 1;\n```\n````',
      'Example:\n```js\nconst value = 1;\n```',
    ],
    ['```md\n    indented code  \n```', '    indented code  '],
  ])('unwraps a complete explicitly labeled response: %s', (input, expected) => {
    expect(unwrapGeneratedMarkdown(input)).toBe(expected);
  });

  it.each([
    '# Summary\n\n- Ship Friday\n',
    '```\nconst value = 1;\n```',
    '```js\nconst value = 1;\n```',
    'Example:\n```markdown\n# Summary\n```',
    '```markdown\n# Summary\n```\nKeep this ending.',
    '```markdown\n# One\n```\n```markdown\n# Two\n```',
    '```markdown\n# Incomplete',
    '````markdown\n# Mismatched close\n```',
    '```markdown\n\n```',
    '',
  ])('preserves content that is not one complete Markdown response wrapper: %s', (input) => {
    expect(unwrapGeneratedMarkdown(input)).toBe(input);
  });
});
