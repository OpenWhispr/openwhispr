import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import type { CalendarParticipant } from '@/data/calendarTypes';

const participant = (overrides: Partial<CalendarParticipant>): CalendarParticipant => ({
  email: null,
  displayName: null,
  responseStatus: 'accepted',
  optional: false,
  organizer: false,
  resource: false,
  self: false,
  ...overrides,
});

describe('buildMeetingNotesInput', () => {
  it('omits calendar context when no meeting context is provided', () => {
    const input = buildMeetingNotesInput({
      rawNotes: 'Focus on onboarding risk.',
      transcript: '[0:00] Speaker 1: We need an owner.',
    });

    expect(input).not.toContain('Calendar context');
    expect(input).toContain('Raw notes captured during the meeting:\nFocus on onboarding risk.');
    expect(input).toContain('Meeting transcript:\n[0:00] Speaker 1: We need an owner.');
  });

  it('adds event title and human participant hints as context only', () => {
    const input = buildMeetingNotesInput({
      rawNotes: 'Alice owns the launch checklist.',
      transcript: '[0:00] Speaker 1: Alice can take this.',
      meetingContext: {
        eventTitle: ' Customer Planning ',
        participants: [
          participant({
            email: 'ALICE@example.com',
            displayName: 'Alice Adams',
          }),
          participant({
            email: 'bob@example.com',
            displayName: 'Bob Brown',
          }),
          participant({
            email: 'declined@example.com',
            displayName: 'Declined Person',
            responseStatus: 'declined',
          }),
          participant({
            email: 'room@example.com',
            displayName: 'Boardroom',
            resource: true,
          }),
        ],
      },
    });

    expect(input).toContain(
      'Calendar context (for interpretation only; do not list this context automatically):',
    );
    expect(input).toContain('Event title: Customer Planning');
    expect(input).toContain(
      'Possible participant hints: Alice Adams <alice@example.com>, Bob Brown <bob@example.com>',
    );
    expect(input).not.toContain('Declined Person');
    expect(input).not.toContain('Boardroom');
  });

  it('omits an empty calendar context block when only the default meeting title is available', () => {
    const input = buildMeetingNotesInput({
      rawNotes: 'Discussed launch checklist.',
      transcript: '[0:00] Speaker 1: Alice can take this.',
      meetingContext: {
        eventTitle: 'Untitled meeting',
        participants: [],
      },
    });

    expect(input).not.toContain('Calendar context');
    expect(input).not.toContain('Event title: Untitled meeting');
  });
});
