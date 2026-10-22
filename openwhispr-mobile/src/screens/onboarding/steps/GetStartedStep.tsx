import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { BRAND_GRADIENT } from '@/config/colors';
import { describeOnboardingError } from '@/lib/onboardingErrors';

const DEEP_BLUE = BRAND_GRADIENT[2];

export function GetStartedStep() {
  const { goNext } = useOnboardingStep('get-started');
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setError(null);
    goNext().catch((cause: unknown) =>
      setError(describeOnboardingError(cause, 'Could not save your progress. Try again.')),
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-systemBackground" edges={['top', 'bottom']}>
      <View className="flex-1 items-center justify-center gap-5 px-8">
        <OpenWhisprMark size={64} color={DEEP_BLUE} />
        <Text
          accessibilityRole="header"
          className="text-[34px] font-bold tracking-tight text-label"
        >
          OpenWhispr
        </Text>
        <Text className="text-center text-[17px] leading-[23px] text-secondaryLabel">
          Your voice is 3x faster than your keyboard.
        </Text>
      </View>

      <View className="px-6 pb-4">
        {error ? (
          <Text accessibilityRole="alert" className="mb-3 text-center text-[14px] text-systemRed">
            {error}
          </Text>
        ) : null}
        <Button onPress={start} size="lg">
          Get Started
        </Button>
      </View>
    </SafeAreaView>
  );
}
