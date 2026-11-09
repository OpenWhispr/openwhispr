import type { UserConfig } from '@/types';

// Usage Analytics defaults to on once the saved config has loaded. Before that
// the preference is unknown, so callers fail closed.
export function isUsageAnalyticsAllowed(config: UserConfig | null): boolean {
  return config !== null && (config.usageAnalyticsEnabled ?? true);
}
