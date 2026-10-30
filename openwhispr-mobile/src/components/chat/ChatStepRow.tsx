import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { CHAT_COLORS } from '@/config/colors';
import { ChatSpinner } from './ChatSpinner';

interface ChatStepRowProps {
  state: 'done' | 'active';
  label: string;
  detail?: string;
}

function StepMarker({ state }: { state: ChatStepRowProps['state'] }): React.JSX.Element {
  if (state === 'done') {
    return (
      <View className="h-5 w-5 items-center justify-center rounded-full" style={styles.done}>
        <SystemIcon
          name="checkmark"
          mdName="Check"
          size={11}
          color={CHAT_COLORS.successForeground}
        />
      </View>
    );
  }
  return (
    <View className="h-5 w-5 items-center justify-center">
      <ChatSpinner />
    </View>
  );
}

export function ChatStepRow({ state, label, detail }: ChatStepRowProps): React.JSX.Element {
  return (
    <View testID="chat-step-row" className="flex-row items-start gap-2.5">
      <StepMarker state={state} />
      <View className="flex-1">
        <Text className="text-[14px] leading-5 text-label">{label}</Text>
        {detail ? (
          <Text className="text-[13px] leading-[18px] text-secondaryLabel">{detail}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  done: { backgroundColor: CHAT_COLORS.successBackground },
});
