import { getNoteChatSuggestions } from '../noteChatSuggestions';
import { getNoteChatSuggestions as getAndroidSuggestions } from '../noteChatSuggestions.android';

describe('note chat suggestion platform boundary', () => {
  it.each([true, false])(
    'retains prompt identity while keeping Android label metadata separate (%s)',
    (isMeeting) => {
      const ios = getNoteChatSuggestions(isMeeting);
      const android = getAndroidSuggestions(isMeeting);
      expect(getNoteChatSuggestions(isMeeting)).toBe(ios);
      expect(getAndroidSuggestions(isMeeting)).toBe(android);
      expect(ios.map(Object.keys)).toEqual(ios.map(() => ['label', 'prompt']));
      expect(android.map(({ labelKey: _labelKey, ...suggestion }) => suggestion)).toEqual(ios);
      expect(android.map((suggestion) => suggestion.labelKey)).toEqual(
        isMeeting
          ? ['noteChat.actionItems', 'noteChat.followupEmail', 'noteChat.decisions', 'noteChat.qa']
          : ['noteChat.summarize', 'noteChat.actionItems', 'noteChat.draftEmail'],
      );
    },
  );
});
