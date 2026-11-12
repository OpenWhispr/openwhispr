import { useEffect, useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useSyncStore } from '@/sync/useSyncStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useUsageStore } from '@/store/useUsageStore';
import { requestSync } from '@/sync/syncEngine';
import { notesRepository } from '@/data';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { formatRelativeTime, safeHaptics } from '@/lib/utils';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { describeConflictCount } from '@/lib/notes/conflictCount';

const RELATIVE_TICK_MS = 30_000;

function describe(
  cloudBackupEnabled: boolean,
  status: string,
  lastSyncAt: string | null,
  lastError: Error | null,
  paidPlanRequired: boolean,
  policyBlocked: boolean,
): string {
  if (paidPlanRequired) return 'Cloud sync requires Pro — tap to upgrade';
  if (policyBlocked) return 'Cloud backup is turned off by your organization.';
  if (!cloudBackupEnabled) return 'Syncing paused. Re-enable in Settings.';
  if (status === 'running') return 'Syncing…';
  if (status === 'error') {
    const msg = lastError?.message ?? 'unknown error';
    return `Sync failed: ${msg} — tap to retry`;
  }
  if (!lastSyncAt) return 'Not synced yet';
  return `Synced ${formatRelativeTime(lastSyncAt, 'long').toLowerCase()}`;
}

export function SyncStatusLabel() {
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const cloudBackupEnabled = useConfigStore((s) => s.config?.cloudBackupEnabled ?? true);
  const { status, lastSyncAt, lastError, subscriptionRequired, policyBlocked } = useSyncStore();
  const usage = useUsageStore((s) => s.usage);
  const loadUsage = useUsageStore((s) => s.load);
  const { register: registerSuperwallGate } = useSuperwallGate();
  // Tick state forces a re-render every 30s so the relative-time string
  // advances without waiting on a sync event. Also doubles as a memo key for the
  // conflict-count read below, so that read runs on a ~30s cadence (or when `status`
  // changes) instead of on every render of this component.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), RELATIVE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (user && !isGuest) loadUsage();
  }, [user, isGuest, loadUsage]);

  // Recomputed on the same ~30s cadence as the relative-time label (via `tick`), or whenever
  // `status` changes (a sync just started/finished, the likeliest time for the conflict set to
  // have changed) — not on every render of this component. Must run before the early return
  // below (Rules of Hooks): a signed-out user renders null and never reaches this component's
  // JSX anyway, so the wasted read on that path is a non-issue.
  const conflictLabel = useMemo(
    () => describeConflictCount(notesRepository.listConflictedNotes().length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, status],
  );

  if (!user || isGuest) return null;

  const paidPlanRequired = usage ? !usage.isSubscribed : subscriptionRequired;
  const isPaused = !cloudBackupEnabled && !paidPlanRequired;
  const isError = status === 'error' && !isPaused && !paidPlanRequired;
  const isRunning = status === 'running' && !isPaused && !paidPlanRequired;
  const isGated = paidPlanRequired;
  const canTapToSync = !isPaused && !isGated;
  const canPress = canTapToSync || isGated;
  const label = describe(
    cloudBackupEnabled,
    status,
    lastSyncAt,
    lastError,
    paidPlanRequired,
    policyBlocked,
  );

  return (
    <Pressable
      disabled={!canPress}
      onPress={() => {
        safeHaptics('selection');
        if (isGated) {
          registerSuperwallGate({
            placement: SUPERWALL_PLACEMENTS.cloudSyncRequired,
            params: {
              source: 'sync_status_label',
              plan: usage?.plan ?? 'unknown',
              status: usage?.status ?? status,
              isSubscribed: usage?.isSubscribed ?? false,
            },
            feature: () => {
              useUsageStore
                .getState()
                .load(true)
                .catch(() => {})
                .finally(() => requestSync('manual'));
            },
          }).catch(() => {});
          return;
        }
        requestSync('manual');
      }}
      accessibilityRole="button"
      accessibilityState={!canPress ? { disabled: true } : undefined}
      accessibilityLabel={`Sync status. ${label}${canTapToSync ? '. Tap to sync now.' : ''}${
        isGated ? '. Tap to upgrade.' : ''
      }${conflictLabel ? `. ${conflictLabel}.` : ''}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <View className="flex-row items-center gap-1.5 pb-2">
        {isPaused && (
          <SystemIcon
            name="pause.circle.fill"
            mdName="CirclePause"
            size={12}
            color="tertiaryLabel"
          />
        )}
        {isRunning && (
          <SystemIcon
            name="arrow.triangle.2.circlepath"
            mdName="RefreshCw"
            size={12}
            color="tertiaryLabel"
          />
        )}
        {isError && (
          <SystemIcon
            name="exclamationmark.triangle.fill"
            mdName="TriangleAlert"
            size={12}
            color="systemRed"
          />
        )}
        {isGated && <SystemIcon name="lock.fill" mdName="Lock" size={12} color="tertiaryLabel" />}
        <Text
          numberOfLines={2}
          className={'flex-1 text-[13px] ' + (isError ? 'text-systemRed' : 'text-tertiaryLabel')}
        >
          {label}
        </Text>
        {conflictLabel && (
          <Text className="text-[13px] font-medium text-systemOrange">{conflictLabel}</Text>
        )}
      </View>
    </Pressable>
  );
}
