import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import { getNotificationStatus, requestNotifications } from '@/lib/notifications';

const STEP_ID = 'notifications';

type PermissionState = 'checking' | 'undetermined' | 'granted' | 'denied' | 'unavailable';

interface Benefit {
  icon: string;
  mdIcon: LucideIconName;
  text: string;
}

const BENEFITS: Benefit[] = [
  { icon: 'lightbulb.fill', mdIcon: 'Lightbulb', text: 'Tips to help you dictate faster' },
  { icon: 'sparkles', mdIcon: 'Sparkles', text: 'Updates about new features' },
];

export function NotificationsStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const setPermissionGranted = useOnboardingStore((s) => s.setPermissionGranted);
  const [state, setState] = useState<PermissionState>('checking');
  const [requesting, setRequesting] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    getNotificationStatus()
      .then((status) => {
        if (status === 'granted') {
          return setPermissionGranted('notifications', true).then(() => goNext());
        }
        if (status === 'unavailable') {
          setState('unavailable');
          return;
        }
        setState(status === 'denied' ? 'denied' : 'undetermined');
      })
      .catch(() => setState('undetermined'));
  }, [goNext, setPermissionGranted]);

  const handleAllow = useCallback(async () => {
    setRequesting(true);
    try {
      const result = await requestNotifications();
      await setPermissionGranted('notifications', result === 'granted');
      if (result === 'denied') {
        setState('denied');
        return;
      }
      await goNext();
    } finally {
      setRequesting(false);
    }
  }, [goNext, setPermissionGranted]);

  const handleOpenSettings = useCallback(() => {
    Linking.openSettings();
  }, []);

  const handleSkip = useCallback(async () => {
    await goNext();
  }, [goNext]);

  if (state === 'checking') {
    return (
      <OnboardingShell
        progress={getStepProgress(STEP_ID)}
        title="Checking permissions…"
        ctaLabel="Continue"
        ctaDisabled
        onCta={handleSkip}
      >
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </OnboardingShell>
    );
  }

  if (state === 'denied') {
    return (
      <OnboardingShell
        progress={getStepProgress(STEP_ID)}
        title="Notifications are off"
        subtitle="Open Settings to allow OpenWhispr notifications."
        ctaLabel="Open Settings"
        onCta={handleOpenSettings}
        secondaryCtaLabel="Continue anyway"
        onSecondaryCta={handleSkip}
      >
        <View className="flex-1 items-center justify-center">
          <View className="h-28 w-28 items-center justify-center rounded-2xl bg-secondarySystemGroupedBackground">
            <SystemIcon name="bell.slash.fill" mdName="BellOff" size={48} color="secondaryLabel" />
          </View>
        </View>
      </OnboardingShell>
    );
  }

  if (state === 'unavailable') {
    return (
      <OnboardingShell
        progress={getStepProgress(STEP_ID)}
        title="Notifications unavailable"
        subtitle="Notification support isn't enabled in this build. You can continue setup."
        ctaLabel="Continue"
        onCta={handleSkip}
      >
        <View className="flex-1" />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      progress={getStepProgress(STEP_ID)}
      title="Stay in the loop"
      titleAccent="loop"
      subtitle="You can opt out anytime."
      ctaLabel="Allow notifications"
      ctaLoading={requesting}
      onCta={handleAllow}
      secondaryCtaLabel="Maybe later"
      onSecondaryCta={handleSkip}
    >
      <View className="flex-1 items-center justify-start">
        <View className="h-28 w-28 items-center justify-center rounded-2xl bg-secondarySystemGroupedBackground">
          <SystemIcon name="bell.badge.fill" mdName="Bell" size={48} color="brand" />
        </View>

        <View className="mt-8 w-full gap-4">
          {BENEFITS.map((benefit) => (
            <View key={benefit.text} className="flex-row items-center">
              <View className="h-6 w-6 items-center justify-center">
                <SystemIcon name={benefit.icon} mdName={benefit.mdIcon} size={18} color="brand" />
              </View>
              <Text className="ml-3 flex-1 text-[15px] leading-[20px] text-label">
                {benefit.text}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </OnboardingShell>
  );
}
