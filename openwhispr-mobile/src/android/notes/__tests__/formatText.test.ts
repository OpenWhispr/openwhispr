import { applyFormat } from '../formatText';

const at = (text: string, caret = text.length) => ({ start: caret, end: caret });

describe('applyFormat', () => {
  it('wraps a selection in bold or italic marks', () => {
    expect(applyFormat('make this loud', { start: 10, end: 14 }, 'bold')).toEqual({
      text: 'make this **loud**',
      caret: 18,
    });
    expect(applyFormat('a word', { start: 2, end: 6 }, 'italic').text).toBe('a _word_');
  });

  it('starts a line mark and removes it when chosen again', () => {
    const bullet = applyFormat('item', at('item'), 'bullet');
    expect(bullet).toEqual({ text: '- item', caret: 6 });
    expect(applyFormat(bullet.text, at(bullet.text), 'bullet')).toEqual({ text: 'item', caret: 4 });
  });

  it('replaces another line mark instead of stacking it', () => {
    expect(applyFormat('- item', at('- item'), 'heading')).toEqual({ text: '## item', caret: 7 });
    expect(applyFormat('## item', at('## item'), 'check')).toEqual({
      text: '- [ ] item',
      caret: 10,
    });
    expect(applyFormat('- [ ] task', at('- [ ] task'), 'bullet').text).toBe('- task');
  });

  it('only changes the caret line', () => {
    const text = 'first\n- second';
    expect(applyFormat(text, at(text), 'heading').text).toBe('first\n## second');
  });

  it('keeps a caret inside the removed mark at the line start', () => {
    expect(applyFormat('## item', at('## item', 1), 'heading')).toEqual({ text: 'item', caret: 0 });
  });
});
