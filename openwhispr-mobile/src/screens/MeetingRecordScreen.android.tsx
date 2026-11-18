import React from 'react';
import { CloudMeetingScreen } from '@/android/CloudMeetingScreen';
import { MeetingRecordScreen as LocalMeetingScreen } from '@/android/MeetingRecordScreen';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { canRunCloudMeeting } from '@/lib/accountAccess';

export function MeetingRecordScreen(): React.JSX.Element {
  const user = useAuthStore((state) => state.user);
  const mode = useProcessingModeStore((state) => state.activeMode);
  return canRunCloudMeeting(user, mode) ? <CloudMeetingScreen /> : <LocalMeetingScreen />;
}
