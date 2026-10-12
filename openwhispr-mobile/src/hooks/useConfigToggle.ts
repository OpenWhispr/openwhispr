import { useCallback } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { safeHaptics } from '@/lib/utils';
import type { UserConfig } from '@/types';

// Returns a setter that persists the field to UserConfig with the standard
// light haptic. Use directly with <SettingsSwitch onValueChange={…}>. Wrap in
// your own useCallback if you need extra side-effects (e.g. kick a sync).
export function useConfigToggle<K extends keyof UserConfig>(
  key: K,
): (value: NonNullable<UserConfig[K]>) => void {
  const updateConfig = useConfigStore((s) => s.updateConfig);
  return useCallback(
    (value: NonNullable<UserConfig[K]>) => {
      safeHaptics('light');
      updateConfig({ [key]: value } as Partial<UserConfig>);
    },
    [key, updateConfig],
  );
}
