import { TAG_GAP, TAG_INSET, placeCoachTag } from '../onboarding/coachTag';
import { diffWords } from '../onboarding/practiceDiff';

const TAG = { width: 50, height: 21 };
// The menu's third row (Edit selection): 6 dp padding, 44 dp rows, 2 dp gaps.
const EDIT_ROW = { x: 6, y: 98, width: 196, height: 44 };

describe('coach tag placement', () => {
  it('sits 8 dp left of a menu opened by a bubble on the right, centred on the row (A73)', () => {
    const menu = { x: 160, y: 320, width: 208, height: 148 };
    const placement = placeCoachTag(menu, EDIT_ROW, TAG, 384);
    expect(placement).toEqual({
      mode: 'outside',
      points: 'right',
      x: 160 - TAG_GAP - TAG.width,
      y: 320 + 98 + 22 - 10.5,
    });
  });

  it('flips to the right of the menu, pointing left, when the bubble is docked left', () => {
    const menu = { x: 16, y: 320, width: 208, height: 148 };
    expect(placeCoachTag(menu, EDIT_ROW, TAG, 384)).toMatchObject({
      mode: 'outside',
      points: 'left',
      x: 16 + 208 + TAG_GAP,
    });
  });

  it('follows the menu on any width: 360 and 412 dp', () => {
    for (const width of [360, 412]) {
      const menu = { x: width - 16 - 208, y: 300, width: 208, height: 148 };
      const placement = placeCoachTag(menu, EDIT_ROW, TAG, width);
      expect(placement.x + TAG.width + TAG_GAP).toBe(menu.x);
    }
  });

  it('goes inside the row when there is no room for 8 dp + tag + 8 dp beside the menu', () => {
    // A wide translated menu leaves 60 dp, less than 8 + 50 + 8.
    const menu = { x: 60, y: 300, width: 308, height: 148 };
    const row = { ...EDIT_ROW, width: 296 };
    expect(placeCoachTag(menu, row, TAG, 384)).toEqual({
      mode: 'inside',
      points: 'right',
      x: 60 + 6 + 296 - TAG_INSET - TAG.width,
      y: 300 + 98 + 22 - 10.5,
    });
  });

  it('stays outside with exactly enough room', () => {
    const menu = { x: TAG_GAP + TAG.width + TAG_GAP, y: 0, width: 300, height: 148 };
    expect(placeCoachTag(menu, EDIT_ROW, TAG, 400).mode).toBe('outside');
  });
});

describe('practice 3 word diff', () => {
  const changedText = (before: string, after: string) =>
    diffWords(before, after)
      .filter((run) => run.changed)
      .map((run) => run.text);

  it('marks only the rewritten words, as on the P3f board', () => {
    const before =
      'Hi Tim,\n\nCould we move our call to Friday at 4pm? Let me know if that works for you.\n\nThanks,\nJosh';
    const after =
      'Hi Tim,\n\nHope your week’s going well! Would it be okay to move our call to Friday at 4pm? No worries if not, just let me know.\n\nThanks so much,\nJosh';
    expect(changedText(before, after)).toEqual([
      'Hope your week’s going well! Would it be okay to',
      'No worries if not, just',
      'so much,',
    ]);
  });

  it('keeps the text whole, spacing and line breaks included', () => {
    const after = 'Hey Tim!\n\nThanks so much,\nJosh';
    expect(
      diffWords('Hi Tim,\n\nThanks,\nJosh', after)
        .map((run) => run.text)
        .join(''),
    ).toBe(after);
  });

  it('marks nothing when nothing changed', () => {
    expect(diffWords('Hi Tim', 'Hi Tim')).toEqual([{ text: 'Hi Tim', changed: false }]);
  });

  it('leaves a word alone when only its case or punctuation changed', () => {
    expect(changedText('Thanks, Josh', 'thanks! Josh')).toEqual([]);
  });
});
