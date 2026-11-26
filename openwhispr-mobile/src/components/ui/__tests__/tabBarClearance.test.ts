import { isTabBarHidden } from '../tabBarClearance';

describe('isTabBarHidden', () => {
  it('shows the bar on tab roots and static stack routes', () => {
    expect(isTabBarHidden(['(tabs)', '(record)'], false)).toBe(false);
    expect(isTabBarHidden(['(tabs)', '(notes)', 'notes'], false)).toBe(false);
    expect(isTabBarHidden(['(tabs)', '(chat)', 'history'], false)).toBe(false);
  });

  it('hides it on the note editor, meeting screen, chat detail and during the handoff', () => {
    expect(isTabBarHidden(['(tabs)', '(notes)', '[id]'], false)).toBe(true);
    expect(isTabBarHidden(['(tabs)', '(notes)', 'meeting-record'], false)).toBe(true);
    expect(isTabBarHidden(['(tabs)', '(chat)', '[id]'], false)).toBe(true);
    expect(isTabBarHidden(['(tabs)', '(record)'], true)).toBe(true);
  });
});
