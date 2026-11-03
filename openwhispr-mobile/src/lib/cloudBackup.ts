import { Platform } from 'react-native';
import type { UserConfig } from '@/types';

export function isCloudBackupEnabled(
  config: Pick<UserConfig, 'cloudBackupEnabled'> | null | undefined,
): boolean {
  return config?.cloudBackupEnabled ?? Platform.OS !== 'android';
}
