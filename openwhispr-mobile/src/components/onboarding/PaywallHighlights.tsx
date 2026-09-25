import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';

const HIGHLIGHTS: { icon: string; mdIcon: LucideIconName; label: string }[] = [
  { icon: 'cloud', mdIcon: 'Cloud', label: 'Cloud transcription with no word limit' },
  { icon: 'arrow.triangle.2.circlepath', mdIcon: 'RefreshCw', label: 'Sync notes across devices' },
  { icon: 'sparkles', mdIcon: 'Sparkles', label: 'AI cleanup, actions, and note chat' },
];

export function PaywallHighlights() {
  return (
    <View className="gap-4 pt-2">
      {HIGHLIGHTS.map((item) => (
        <View key={item.label} className="flex-row items-center gap-3">
          <SystemIcon name={item.icon} mdName={item.mdIcon} size={20} />
          <Text className="flex-1 text-[16px] text-label">{item.label}</Text>
        </View>
      ))}
    </View>
  );
}
