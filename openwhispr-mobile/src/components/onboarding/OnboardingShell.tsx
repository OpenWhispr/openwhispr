import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';

interface OnboardingShellProps {
  progress?: { current: number; total: number };
  onSkip?: () => void | Promise<unknown>;
  onBack?: () => void | Promise<unknown>;
  avoidKeyboard?: boolean;
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
  onCta: () => void | Promise<unknown>;
  secondaryCtaLabel?: string;
  onSecondaryCta?: () => void | Promise<unknown>;
  secondaryCtaVariant?: 'link' | 'card';
  children?: ReactNode;
}

type OnboardingAction = 'primary' | 'secondary' | 'back' | 'skip';

export function OnboardingShell({
  progress,
  onSkip,
  onBack,
  avoidKeyboard = false,
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
  const inFlight = useRef(false);
  const failedAction = useRef<OnboardingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (actionName: OnboardingAction): Promise<void> => {
    if (inFlight.current) return;
    const action = { primary: onCta, secondary: onSecondaryCta, back: onBack, skip: onSkip }[
      actionName
    ];
    if (!action) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      failedAction.current = actionName;
      setError(cause instanceof Error ? cause.message : 'Could not save your progress. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <SafeAreaView className="flex-1 bg-systemBackground" edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        className="flex-1"
        enabled={avoidKeyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View className="flex-row items-center justify-between px-6 pt-2">
          {onBack ? (
            <Pressable
              onPress={() => run('back')}
              disabled={busy}
              hitSlop={12}
              accessibilityRole="button"
              className="mr-4 py-2"
            >
              <Text className="text-[15px] font-medium text-secondaryLabel">Back</Text>
            </Pressable>
          ) : null}
          <View className="flex-1 pr-4">
            {progress ? (
              <Text className="text-[13px] font-medium text-secondaryLabel">
                Step {progress.current} of {progress.total}
              </Text>
            ) : null}
          </View>
          {onSkip ? (
            <Pressable
              onPress={() => run('skip')}
              disabled={busy}
              hitSlop={12}
              accessibilityRole="button"
            >
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
          {error ? (
            <View className="mb-3 flex-row items-center gap-3">
              <Text accessibilityRole="alert" className="flex-1 text-[14px] text-systemRed">
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy || (failedAction.current === 'primary' && ctaDisabled)}
                hitSlop={12}
                onPress={() => {
                  if (failedAction.current) run(failedAction.current);
                }}
              >
                <Text className="text-[15px] font-medium text-primary">Retry</Text>
              </Pressable>
            </View>
          ) : null}
          <Button
            onPress={() => run('primary')}
            disabled={ctaDisabled || busy}
            loading={ctaLoading || busy}
            size="lg"
          >
            {ctaLabel}
          </Button>
          {secondaryCtaLabel && onSecondaryCta ? (
            secondaryCtaVariant === 'card' ? (
              <Pressable
                onPress={() => run('secondary')}
                disabled={busy}
                accessibilityRole="button"
                className="mt-3 items-center justify-center rounded-full border border-separator bg-secondarySystemGroupedBackground py-4 active:opacity-80"
              >
                <Text className="text-[16px] font-semibold text-label">{secondaryCtaLabel}</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => run('secondary')}
                disabled={busy}
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
      </KeyboardAvoidingView>
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
