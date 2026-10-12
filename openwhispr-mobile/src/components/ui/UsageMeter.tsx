import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import type { UsageInfo } from '@/data/remote/usageApi';

const WARN_RATIO = 0.8;

function isUnlimited(usage: UsageInfo): boolean {
  return usage.isSubscribed || usage.limit <= 0 || !Number.isFinite(usage.limit);
}

function usageRatio(usage: UsageInfo): number {
  return Math.min(Math.max(usage.wordsUsed, 0) / usage.limit, 1);
}

function fillColor(ratio: number): string {
  if (ratio >= 1) return 'bg-systemRed';
  if (ratio >= WARN_RATIO) return 'bg-systemOrange';
  return 'bg-systemGreen';
}

export function formatResetLabel(resetAt: string): string {
  const remainingMs = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';
  const hours = Math.ceil(remainingMs / 3_600_000);
  if (hours < 24) return `Resets in ${hours}h`;
  return `Resets in ${Math.round(hours / 24)}d`;
}

// Full meter for the Account screen. Expects to sit inside a SettingsSection,
// which supplies the card chrome.
export function UsageMeter({ usage }: { usage: UsageInfo | null }) {
  if (!usage) return null;

  if (isUnlimited(usage)) {
    return (
      <View className="flex-row items-baseline justify-between px-4 py-3.5">
        <Text className="text-[15px] text-label">Words this week</Text>
        <Text className="text-[15px] font-semibold text-systemGreen">Unlimited</Text>
      </View>
    );
  }

  const ratio = usageRatio(usage);
  const remaining = Math.max(usage.limit - usage.wordsUsed, 0);
  const resetLabel = formatResetLabel(usage.resetAt);

  return (
    <View className="px-4 py-3.5">
      <View className="flex-row items-baseline justify-between">
        <Text className="text-[15px] text-label">Words this week</Text>
        <Text className="text-[15px] font-semibold text-label">
          {usage.wordsUsed.toLocaleString()} / {usage.limit.toLocaleString()}
        </Text>
      </View>
      <View className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-quaternarySystemFill">
        <View
          className={`h-full rounded-full ${fillColor(ratio)}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </View>
      <View className="mt-2 flex-row items-baseline justify-between">
        <Text className="text-[13px] text-secondaryLabel">
          {ratio >= 1 ? 'Weekly limit reached' : `${remaining.toLocaleString()} left`}
        </Text>
        {resetLabel ? <Text className="text-[13px] text-tertiaryLabel">{resetLabel}</Text> : null}
      </View>
    </View>
  );
}

// Compact warning shown elsewhere (e.g. Home) only once the free user is near
// or over the weekly limit. Renders nothing otherwise.
export function UsageLimitBanner({
  usage,
  onPress,
}: {
  usage: UsageInfo | null;
  onPress?: () => void;
}) {
  if (!usage || isUnlimited(usage)) return null;

  const ratio = usageRatio(usage);
  if (ratio < WARN_RATIO) return null;

  const over = ratio >= 1;
  const message = over
    ? 'Weekly word limit reached'
    : `${Math.round(ratio * 100)}% of weekly words used`;

  return (
    <Pressable
      onPress={() => {
        safeHaptics('light');
        if (onPress) {
          onPress();
        } else {
          router.push('/(account)');
        }
      }}
      className={`mt-2 flex-row items-center gap-2 rounded-xl px-3 py-2.5 active:opacity-80 ${
        over ? 'bg-systemRed/10' : 'bg-systemOrange/10'
      }`}
    >
      <SystemIcon
        name="exclamationmark.triangle.fill"
        mdName="AlertTriangle"
        size={14}
        color={over ? 'systemRed' : 'systemOrange'}
      />
      <Text className="flex-1 text-[13px] font-medium text-label">{message}</Text>
      <SystemIcon name="chevron.right" mdName="ChevronRight" size={12} color="tertiaryLabel" />
    </Pressable>
  );
}
