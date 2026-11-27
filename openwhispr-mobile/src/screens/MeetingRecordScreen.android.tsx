import React, { useEffect } from 'react';
import { CloudMeetingScreen } from '@/android/CloudMeetingScreen';
import { MeetingRecordScreen as LocalMeetingScreen } from '@/android/MeetingRecordScreen';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useProcessingModeStore } from '@/android/shared/store/useProcessingModeStore';
import { canRunCloudMeeting } from '@/android/lib/accountAccess';
import { dlog } from '@/android/lib/debugLog';

export function MeetingRecordScreen(): React.JSX.Element {
  const user = useAuthStore((state) => state.user);
  const mode = useProcessingModeStore((state) => state.activeMode);
  const cloud = canRunCloudMeeting(user, mode);
  const signedIn = !!user && !user.isAnonymous;
  useEffect(() => {
    dlog.info('meet', 'route', {
      mode: cloud ? 'cloud' : 'local',
      why: cloud ? 'cloud_allowed' : mode === 'private' ? 'private_mode' : 'no_account',
      signed_in: signedIn,
    });
  }, [cloud, mode, signedIn]);
  return cloud ? <CloudMeetingScreen /> : <LocalMeetingScreen />;
}
