jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  cacheDirectory: 'file:///cache/',
}));

import { isManagedMeetingAudioUri, meetingRecordingUri } from '@/lib/transcriptAudio';

describe('meetingRecordingUri', () => {
  it('is the one path a meeting records to, and is recognised as managed', () => {
    const uri = meetingRecordingUri(7);
    expect(uri.endsWith('meeting-7.wav')).toBe(true);
    expect(isManagedMeetingAudioUri(7, uri)).toBe(true);
    expect(isManagedMeetingAudioUri(8, uri)).toBe(false);
  });
});
