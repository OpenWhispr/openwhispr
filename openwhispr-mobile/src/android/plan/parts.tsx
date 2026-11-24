import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import type { UsageInfo } from '@/data/remote/usageApi';
import { ProgressBar } from '../controls';
import { useHome } from '../home/kit';
import { useSettingsLook } from '../settings/look';
import { useTheme } from '../ThemeProvider';
import { formatResetParts, resetDate } from './planState';
import { usePlanT } from './strings';

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

/** One line of the meter's foot: the reset time, or nothing while the API's window is rolling. */
export function useResetLine(usage: UsageInfo): string | null {
  const t = usePlanT();
  const { i18n } = useTranslation();
  const date = resetDate(usage.resetAt);
  if (!date) return null;
  return t('resets', formatResetParts(date, i18n.language));
}

/**
 * "Cloud words this week  73 / 2 000", a bar, and "Resets Mon 30 Nov at 00:00" (never "N left").
 * Unlimited plans show the word Unlimited and no bar. `action` sits at the end of the reset line.
 */
export function WordsMeter({ usage, action }: { usage: UsageInfo; action?: ReactNode }) {
  const t = usePlanT();
  const { c, type } = useHome();
  const reset = useResetLine(usage);
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
      {!unlimited && (reset || action) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 20 }}>
          <Text style={[type.footnote, { flex: 1, fontSize: 12, color: c.tertiary }]}>
            {reset ?? ''}
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
      <Text style={{ color: th.tokens.onGlass, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}
