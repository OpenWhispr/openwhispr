import { StyleSheet, View } from 'react-native';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { CHAT_COLORS } from '@/config/colors';

export function ChatWatermark(): React.JSX.Element {
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      className="items-center justify-center"
    >
      <OpenWhisprMark size={132} color={CHAT_COLORS.watermark} />
    </View>
  );
}
