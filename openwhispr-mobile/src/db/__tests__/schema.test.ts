import {
  transcriptSegments,
  speakers,
  notes,
  speakerProfiles,
  googleCalendarAccounts,
  googleCalendars,
  googleCalendarSyncState,
  googleCalendarEvents,
} from '@/db/schema';

const cols = (t: object) => Object.keys(t);

describe('diarization schema', () => {
  it('defines transcript_segments with the expected columns', () => {
    expect(cols(transcriptSegments)).toEqual(
      expect.arrayContaining([
        'id',
        'noteId',
        'startMs',
        'endMs',
        'text',
        'speakerLabel',
        'sortOrder',
      ]),
    );
  });
  it('defines speakers with label-stability columns', () => {
    expect(cols(speakers)).toEqual(
      expect.arrayContaining([
        'id',
        'noteId',
        'speakerLabel',
        'displayName',
        'profileId',
        'color',
        'speakerStatus',
        'speakerLocked',
        'speakerLockSource',
      ]),
    );
  });
  it('adds diarization columns to notes', () => {
    expect(cols(notes)).toEqual(
      expect.arrayContaining([
        'diarizationEnabled',
        'expectedSpeakerCount',
        'transcriptionStatus',
        'calendarEventId',
        'participants',
      ]),
    );
  });
  it('defines Google Calendar integration tables', () => {
    expect(cols(googleCalendarAccounts)).toEqual(
      expect.arrayContaining([
        'id',
        'googleSubject',
        'email',
        'displayName',
        'grantedScopes',
        'status',
        'lastSyncAt',
        'lastError',
      ]),
    );
    expect(cols(googleCalendars)).toEqual(
      expect.arrayContaining([
        'id',
        'accountId',
        'googleCalendarId',
        'summary',
        'isPrimary',
        'accessRole',
        'selected',
        'deletedAt',
      ]),
    );
    expect(cols(googleCalendarSyncState)).toEqual(
      expect.arrayContaining(['accountId', 'resourceType', 'syncToken', 'updatedAt']),
    );
    expect(cols(googleCalendarEvents)).toEqual(
      expect.arrayContaining([
        'id',
        'accountId',
        'calendarLocalId',
        'googleCalendarId',
        'googleEventId',
        'iCalUID',
        'summary',
        'startAt',
        'endAt',
        'attendeesJson',
      ]),
    );
  });
  it('defines local-only speaker_profiles without sync columns', () => {
    expect(cols(speakerProfiles)).toEqual(
      expect.arrayContaining([
        'id',
        'displayName',
        'email',
        'isOwner',
        'embedding',
        'sampleCount',
        'consentAt',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(cols(speakerProfiles)).not.toEqual(
      expect.arrayContaining(['clientProfileId', 'remoteId', 'deletedAt', 'pendingSync']),
    );
  });
});
