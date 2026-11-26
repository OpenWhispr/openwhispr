import type { UserConfig } from '@/android/types';

export function isCloudBackupEnabled(
  config: Pick<UserConfig, 'cloudBackupEnabled'> | null | undefined,
): boolean {
  return config?.cloudBackupEnabled ?? false;
}
