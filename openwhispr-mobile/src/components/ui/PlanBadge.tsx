import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { UsageInfo } from '@/data/remote/usageApi';

type PlanTone = 'free' | 'trial' | 'pro';

const TONE_BG: Record<PlanTone, string> = {
  free: 'bg-quaternarySystemFill',
  trial: 'bg-link/15',
  pro: 'bg-systemGreen/15',
};

const TONE_TEXT: Record<PlanTone, string> = {
  free: 'text-secondaryLabel',
  trial: 'text-link',
  pro: 'text-systemGreen',
};

const TONE_LABEL: Record<PlanTone, string> = {
  free: 'Free',
  trial: 'Trial',
  pro: 'Pro',
};

function getPlanTone(usage: UsageInfo): PlanTone {
  if (usage.isTrial) return 'trial';
  if (usage.isSubscribed) return 'pro';
  return 'free';
}

export function PlanBadge({ usage }: { usage: UsageInfo | null }) {
  if (!usage) return null;
  const tone = getPlanTone(usage);
  return (
    <View
      style={{ borderCurve: 'continuous' }}
      className={`rounded-md px-2 py-0.5 ${TONE_BG[tone]}`}
    >
      <Text className={`text-[11px] font-semibold uppercase tracking-wider ${TONE_TEXT[tone]}`}>
        {TONE_LABEL[tone]}
      </Text>
    </View>
  );
}
