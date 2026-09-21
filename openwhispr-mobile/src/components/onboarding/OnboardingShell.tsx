import { type ReactElement, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';

interface OnboardingShellProps {
  progress?: { current: number; total: number };
  onSkip?: () => void;
  /** Label for the top-right dismiss affordance. Onboarding steps skip ahead;
   * standalone screens that reuse this shell close instead. */
  skipLabel?: string;
  title: string;
  titleAccent?: string;
  /** Optional custom title node — overrides the default text rendering so a
   * step can mix icons / images inline with its heading. */
  titleNode?: ReactNode;
  subtitle?: string;
  ctaLabel: string;
  ctaDisabled?: boolean;
  ctaLoading?: boolean;
  onCta: () => void;
  secondaryCtaLabel?: string;
  onSecondaryCta?: () => void;
  secondaryCtaVariant?: 'link' | 'card';
  children?: ReactNode;
}

export function OnboardingShell({
  progress,
  onSkip,
  skipLabel = 'Skip',
  title,
  titleAccent,
  titleNode,
  subtitle,
  ctaLabel,
  ctaDisabled,
  ctaLoading,
  onCta,
  secondaryCtaLabel,
  onSecondaryCta,
  secondaryCtaVariant = 'link',
  children,
}: OnboardingShellProps): ReactElement {
  return (
    <SafeAreaView className="flex-1 bg-systemBackground" edges={['top', 'bottom']}>
      <View className="flex-row items-center justify-between px-6 pt-2">
        <View className="flex-1 pr-4">
          {progress ? (
            <Text className="text-[13px] font-medium text-secondaryLabel">
              Step {progress.current} of {progress.total}
            </Text>
          ) : null}
        </View>
        {onSkip ? (
          <Pressable onPress={onSkip} hitSlop={12} accessibilityRole="button">
            <Text className="text-[15px] font-medium text-secondaryLabel">{skipLabel}</Text>
          </Pressable>
        ) : null}
      </View>

      <View className="flex-1 px-6 pt-8">
        {titleNode ?? (
          <Text
            accessibilityRole="header"
            className="text-[30px] font-medium leading-[36px] text-label"
          >
            {renderTitle(title, titleAccent)}
          </Text>
        )}
        {subtitle ? (
          <Text className="mt-2 text-[16px] leading-[21px] text-secondaryLabel">{subtitle}</Text>
        ) : null}

        <View className="mt-6 flex-1">{children}</View>
      </View>

      <View className="px-6 pb-4">
        <Button onPress={onCta} disabled={ctaDisabled} loading={ctaLoading} size="lg">
          {ctaLabel}
        </Button>
        {secondaryCtaLabel && onSecondaryCta ? (
          secondaryCtaVariant === 'card' ? (
            <Pressable
              onPress={onSecondaryCta}
              accessibilityRole="button"
              className="mt-3 items-center justify-center rounded-full border border-separator bg-secondarySystemGroupedBackground py-4 active:opacity-80"
            >
              <Text className="text-[16px] font-semibold text-label">{secondaryCtaLabel}</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={onSecondaryCta}
              className="mt-3 items-center justify-center py-2"
              accessibilityRole="button"
            >
              <Text className="text-[15px] font-medium text-secondaryLabel">
                {secondaryCtaLabel}
              </Text>
            </Pressable>
          )
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function renderTitle(title: string, accent: string | undefined): ReactNode {
  if (!accent) return title;
  const idx = title.indexOf(accent);
  if (idx === -1) return title;
  return (
    <>
      {title.slice(0, idx)}
      <Text className="text-primary">{accent}</Text>
      {title.slice(idx + accent.length)}
    </>
  );
}
