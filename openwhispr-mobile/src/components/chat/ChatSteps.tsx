import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { CHAT_COLORS } from '@/config/colors';
import type { ChatStep } from '@/lib/chat/types';
import { ChatSlowNotice } from './ChatSlowNotice';
import { ChatSparkle } from './ChatSparkle';
import { ChatStepRow } from './ChatStepRow';
import { formatElapsed } from './formatElapsed';
import { usePulseStyle } from './useChatMotion';

interface ChatStepsProps {
  steps: ChatStep[];
  variant: 'working' | 'done';
  sourceCount?: number;
  /** How many notes were read, cited or not; null when that can't be told. */
  readCount?: number | null;
  /** Epoch ms when the turn began; without it "Still working" never shows. */
  startedAt?: number;
  /** Whether its screen is showing, so a covered chat stays quiet; a stable callback. */
  isFocused?: () => boolean;
}

const SLOW_AFTER_MS = 15_000;
// The steps before the answer finish in a moment, so each one's status stays up this long, in turn,
// while the request is already on its way.
const STATUS_DWELL_MS = 700;
const SLOW_LABEL = 'Still working';

// Notes read but named by none of the answer are still read, so they aren't "no matches".
const sourcesLabel = (count: number, readCount: number | null): string => {
  if (count > 0) return `Searched your notes · ${count} ${count === 1 ? 'source' : 'sources'}`;
  if (readCount === null) return 'Searched your notes';
  if (readCount === 0) return 'Searched your notes · no matches';
  return `Searched your notes · ${readCount} read`;
};

export function ChatSteps({
  steps,
  variant,
  sourceCount = 0,
  readCount = 0,
  startedAt,
  isFocused,
}: ChatStepsProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const working = variant === 'working';
  // Dims no further than keeps the label readable.
  const labelPulse = usePulseStyle(0.6, 1000, working);

  useEffect(() => {
    if (!working) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [working]);

  // A saved message can carry a step that was still active when the app closed;
  // it must not show a spinner.
  const shownSteps = working ? steps : steps.map((step): ChatStep => ({ ...step, status: 'done' }));
  const statuses = steps.flatMap((step) => {
    const status = step.status === 'active' ? step.label : step.activeLabel;
    return status ? [status] : [];
  });
  const [statusIndex, setStatusIndex] = useState(0);
  const lastStatus = statuses.length - 1;
  useEffect(() => {
    if (!working || statusIndex >= lastStatus) return;
    const timer = setTimeout(() => setStatusIndex((index) => index + 1), STATUS_DWELL_MS);
    return () => clearTimeout(timer);
  }, [working, statusIndex, lastStatus]);
  const status = statuses[Math.min(statusIndex, lastStatus)];
  const elapsedMs = working && startedAt != null ? now - startedAt : 0;
  const slow = working && startedAt != null && elapsedMs >= SLOW_AFTER_MS;
  const headerLabel = slow
    ? SLOW_LABEL
    : working
      ? (status ?? 'Thinking…')
      : sourcesLabel(sourceCount, readCount);

  // Announced once rather than through a live region, which Android would also read on every
  // step change and again for this.
  useEffect(() => {
    if (slow && (isFocused?.() ?? true)) {
      AccessibilityInfo.announceForAccessibility(`${SLOW_LABEL} on your answer.`);
    }
  }, [slow, isFocused]);

  return (
    <View
      className={slow ? 'bg-secondarySystemGroupedBackground p-3' : undefined}
      style={slow ? styles.slowCard : undefined}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        className="min-h-[44px] flex-row items-center gap-2.5 active:opacity-70"
      >
        {working ? (
          <ChatSparkle />
        ) : (
          <View
            className="h-5 w-5 items-center justify-center rounded-full"
            style={styles.doneMark}
          >
            <SystemIcon
              name="checkmark"
              mdName="Check"
              size={11}
              color={CHAT_COLORS.successForeground}
            />
          </View>
        )}
        <Animated.View style={[styles.labelWrap, working ? labelPulse : null]}>
          <Text
            className={
              working ? 'text-[15px] font-medium text-label' : 'text-[14px] text-secondaryLabel'
            }
            numberOfLines={1}
          >
            {headerLabel}
          </Text>
        </Animated.View>
        {slow ? (
          <Text className="ml-auto text-[13px] text-secondaryLabel">
            {formatElapsed(Math.floor(elapsedMs / 1000))}
          </Text>
        ) : null}
        <View style={expanded ? styles.flipped : undefined}>
          <SystemIcon name="chevron.down" mdName="ChevronDown" size={16} color="secondaryLabel" />
        </View>
      </Pressable>

      {slow ? <ChatSlowNotice /> : null}

      {expanded ? (
        <View className="mt-2 gap-2.5 pb-1">
          {shownSteps.map((step) => (
            <ChatStepRow
              key={step.id}
              state={step.status}
              label={step.label}
              detail={step.detail}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  slowCard: {
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHAT_COLORS.hairline,
  },
  doneMark: { backgroundColor: CHAT_COLORS.successBackground },
  labelWrap: { flexShrink: 1 },
  flipped: { transform: [{ rotate: '180deg' }] },
});
