import { isKeyboardSettingsLinkFresh, markKeyboardSettingsLink } from '@/lib/keyboardSettingsLink';

describe('keyboardSettingsLink', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is fresh for five seconds after the link arrives', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    expect(isKeyboardSettingsLinkFresh()).toBe(false);
    markKeyboardSettingsLink();
    expect(isKeyboardSettingsLinkFresh()).toBe(true);
    jest.setSystemTime(new Date('2026-11-24T12:00:04.999Z'));
    expect(isKeyboardSettingsLinkFresh()).toBe(true);
    jest.setSystemTime(new Date('2026-11-24T12:00:05Z'));
    expect(isKeyboardSettingsLinkFresh()).toBe(false);
  });
});
