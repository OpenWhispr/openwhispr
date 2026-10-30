import { formatConversationTime } from '../formatConversationTime';
import { formatElapsed } from '../formatElapsed';

describe('formatElapsed', () => {
  it('formats m:ss', () => {
    expect(formatElapsed(7)).toBe('0:07');
    expect(formatElapsed(83)).toBe('1:23');
    expect(formatElapsed(-4)).toBe('0:00');
  });
});

describe('formatConversationTime', () => {
  const now = new Date(2026, 9, 22, 15, 30);

  it('shows the time today', () => {
    expect(formatConversationTime(new Date(2026, 9, 22, 9, 5).getTime(), now)).toBe('9:05 AM');
    expect(formatConversationTime(new Date(2026, 9, 22, 0, 10).getTime(), now)).toBe('12:10 AM');
    expect(formatConversationTime(new Date(2026, 9, 22, 13, 0).getTime(), now)).toBe('1:00 PM');
  });

  it('shows Yesterday even for late-night messages', () => {
    expect(formatConversationTime(new Date(2026, 9, 21, 23, 50).getTime(), now)).toBe('Yesterday');
  });

  it('shows a weekday within the last six days', () => {
    expect(formatConversationTime(new Date(2026, 9, 20, 12).getTime(), now)).toBe('Tuesday');
    expect(formatConversationTime(new Date(2026, 9, 16, 12).getTime(), now)).toBe('Friday');
  });

  it('shows Mon D beyond that', () => {
    expect(formatConversationTime(new Date(2026, 9, 15, 12).getTime(), now)).toBe('Oct 15');
  });

  it('adds the year for an earlier year', () => {
    expect(formatConversationTime(new Date(2025, 9, 15, 12).getTime(), now)).toBe('Oct 15, 2025');
  });
});
