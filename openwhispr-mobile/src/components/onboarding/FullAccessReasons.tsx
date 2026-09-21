import { View } from 'react-native';
import { Disclosure } from '@/components/onboarding/Disclosure';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';

const REASONS = [
  'Enables transcription in all apps',
  'Required by Apple for custom keyboards',
  'We never store or sell your recordings',
];

/** The "why do you need this?" answer, shown wherever we ask for Full Access. */
export function FullAccessReasons() {
  return (
    <Disclosure title="Why does OpenWhispr need Full Access?">
      <View className="gap-2">
        {REASONS.map((reason) => (
          <View key={reason} className="flex-row items-start gap-2">
            <View className="mt-px">
              <SystemIcon name="checkmark" mdName="Check" size={13} color="systemGreen" />
            </View>
            <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">{reason}</Text>
          </View>
        ))}
      </View>
    </Disclosure>
  );
}
