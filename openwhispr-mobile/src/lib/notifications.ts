let notificationsModule: typeof import('expo-notifications') | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  notificationsModule = require('expo-notifications');
} catch (error) {
  if (__DEV__) {
    console.warn(
      '[expo-notifications] Native module unavailable. Notification permission will be skipped.',
      (error as Error)?.message ?? error,
    );
  }
}

export type NotificationStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export async function requestNotifications(): Promise<NotificationStatus> {
  if (!notificationsModule) return 'unavailable';
  const result = await notificationsModule.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
    },
  });
  if (result.granted) return 'granted';
  if (result.canAskAgain === false || result.status === 'denied') return 'denied';
  return 'undetermined';
}

export async function getNotificationStatus(): Promise<NotificationStatus> {
  if (!notificationsModule) return 'unavailable';
  const result = await notificationsModule.getPermissionsAsync();
  if (result.granted) return 'granted';
  if (result.status === 'denied') return 'denied';
  return 'undetermined';
}
