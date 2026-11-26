import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import type { UsageInfo } from '@/android/remote/usageApi';
import { ProgressBar } from '../controls';
import { useHome } from '../home/kit';
import { useSettingsLook } from '../settings/look';
import { useTheme } from '../ThemeProvider';
import { usePlanT } from './strings';
import { buildUsageGateParams } from '@/android/shared/lib/superwall';
import type { SuperwallPlacement } from '@/android/shared/lib/superwall';
import type { useSuperwallGate } from '@/android/shared/hooks/useSuperwallGate';

/**
 * A "Go unlimited" door (Settings, Home's low-words card). While a purchase is still on its way
 * it opens Plan & billing, which shows that wait, rather than a paywall that offers a second
 * checkout.
 */
export function openUpgrade(
  usage: UsageInfo,
  register: ReturnType<typeof useSuperwallGate>['register'],
  placement: SuperwallPlacement,
): Promise<unknown> {
  // Loaded on tap, not at import: screens that only show a meter never load the store.
  const { useAndroidBillingStatus } = require('../billing') as typeof import('../billing');
  const status = usage.billingUserId
    ? useAndroidBillingStatus.getState().accounts[usage.billingUserId]
    : undefined;
  if (status && status !== 'idle') {
    router.push('/android-pro');
    return Promise.resolve();
  }
  return register({ placement, params: buildUsageGateParams(usage) });
}

export type ChipTone = 'neutral' | 'accent' | 'amber';

/** The small uppercase tag above a plan's name: YOUR PLAN (grey on every plan), CONFIRMING, ACTION NEEDED. */
export function StatusChip({ label, tone }: { label: string; tone: ChipTone }) {
  const th = useTheme();
  const k = th.tokens;
  const fill = tone === 'neutral' ? k.track : tone === 'amber' ? k.amberFill : k.selFill;
  const ink = tone === 'neutral' ? k.secondary : tone === 'amber' ? k.amber : k.accent;
  return (
    <View
      style={[
        { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
        { backgroundColor: fill },
      ]}
    >
      <Text
        style={{
          fontSize: 10,
          lineHeight: 14,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: ink,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * "Cloud words this week  73 / 2 000", a bar, and "Rolling 7-day allowance" (never "N left" or a reset date).
 * Unlimited plans show the word Unlimited and no bar. `action` sits at the end of the allowance line.
 */
export function WordsMeter({ usage, action }: { usage: UsageInfo; action?: ReactNode }) {
  const t = usePlanT();
  const { c, type } = useHome();
  const unlimited = usage.isSubscribed || usage.limit <= 0;
  const used = Math.max(usage.wordsUsed, 0);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text style={[type.footnote, { flex: 1, color: c.text }]}>{t('cloudWordsThisWeek')}</Text>
        <Text
          style={[
            type.footnote,
            { fontVariant: ['tabular-nums'], fontWeight: '600' },
            { color: unlimited ? c.accent : c.text },
          ]}
        >
          {unlimited
            ? t('unlimited')
            : `${used.toLocaleString()} / ${usage.limit.toLocaleString()}`}
        </Text>
      </View>
      {!unlimited && (
        <ProgressBar
          accessibilityLabel={t('cloudWordsThisWeek')}
          value={Math.max(0.02, used / Math.max(1, usage.limit))}
        />
      )}
      {!unlimited && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 20 }}>
          <Text style={[type.footnote, { flex: 1, fontSize: 12, color: c.tertiary }]}>
            {t('rollingAllowance')}
          </Text>
          {action}
        </View>
      )}
    </View>
  );
}

/** The card at the top of Plan & billing: chip, plan name, a line about it, the words meter. */
export function PlanCard({
  chip,
  title,
  body,
  usage,
  footer,
}: {
  chip: { label: string; tone: ChipTone };
  title: string;
  body?: string;
  usage?: UsageInfo | null;
  footer?: ReactNode;
}) {
  const { edgeCard } = useSettingsLook();
  const { c, type } = useHome();
  return (
    <View style={[edgeCard, { padding: 16, gap: 10 }]}>
      <StatusChip {...chip} />
      <Text
        accessibilityRole="header"
        style={{ fontSize: 24, lineHeight: 30, fontWeight: '700', color: c.text }}
      >
        {title}
      </Text>
      {body ? <Text style={[type.footnote, { fontSize: 14, lineHeight: 20 }]}>{body}</Text> : null}
      {usage && (
        <View style={{ marginTop: 6 }}>
          <WordsMeter usage={usage} />
        </View>
      )}
      {footer}
    </View>
  );
}

/** A quiet accent text link: Restore purchases, Get help, Go unlimited. */
export function LinkText({
  label,
  onPress,
  small,
  disabled,
}: {
  label: string;
  onPress: () => void;
  small?: boolean;
  disabled?: boolean;
}) {
  const { c } = useHome();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      hitSlop={10}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'center',
        paddingVertical: small ? 0 : 10,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          color: c.accent,
          fontSize: small ? 12 : 15,
          lineHeight: small ? 16 : 20,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The small glass pill on Home's low-words card ("Go unlimited"). */
export function GlassPill({ label, onPress }: { label: string; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
        th.glass,
        pressed && th.glassPressed,
      ]}
    >
      <Text style={{ color: th.tokens.onGlass, fontSize: 12, lineHeight: 16, fontWeight: '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}
