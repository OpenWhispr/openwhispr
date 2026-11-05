import type { UserConfig } from '@/types';

export function isCloudBackupEnabled(
  config: Pick<UserConfig, 'cloudBackupEnabled'> | null | undefined,
): boolean {
  return config?.cloudBackupEnabled ?? false;
}
