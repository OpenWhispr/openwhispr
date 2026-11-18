import { useEffect, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { useBubbleStatus } from '../home/BubbleCard';
import type { SettingsKey } from './strings';

export type PermissionKey = 'microphone' | 'overlay' | 'insertion' | 'notifications' | 'background';

export const PERMISSION_ROWS: {
  key: PermissionKey;
  title: SettingsKey;
  body: SettingsKey;
  icon: 'Mic' | 'PictureInPicture2' | 'Hand' | 'Bell' | 'Power';
}[] = [
  { key: 'microphone', title: 'microphone', body: 'microphoneBody', icon: 'Mic' },
  { key: 'overlay', title: 'overlay', body: 'overlayRowBody', icon: 'PictureInPicture2' },
  { key: 'insertion', title: 'insertion', body: 'insertionBody', icon: 'Hand' },
  { key: 'notifications', title: 'notifications', body: 'notificationsBody', icon: 'Bell' },
  { key: 'background', title: 'background', body: 'backgroundBody', icon: 'Power' },
];

const asksForNotifications = () => Number(Platform.Version) >= 33;

/** What the bubble needs and whether Android has granted it, re-read whenever the app returns. */
export function usePermissions() {
  const { status, refresh } = useBubbleStatus();
  const [notifications, setNotifications] = useState(true);
  useEffect(() => {
    if (!asksForNotifications()) return;
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      .then(setNotifications)
      .catch(() => undefined);
  }, [status]);
  const granted: Record<PermissionKey, boolean> = {
    microphone: Boolean(status?.microphone),
    overlay: Boolean(status?.overlay),
    insertion: Boolean(status?.accessibility),
    notifications,
    background: Boolean(status?.batteryExempt),
  };
  const offCount = PERMISSION_ROWS.filter(({ key }) => !granted[key]).length;
  return { status, granted, offCount, refresh };
}

/** Android's own permission dialog, where it still asks; true once granted. */
export async function requestRuntime(key: 'microphone' | 'notifications'): Promise<boolean> {
  if (key === 'notifications' && !asksForNotifications()) return true;
  const result = await PermissionsAndroid.request(
    key === 'microphone'
      ? PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      : PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
