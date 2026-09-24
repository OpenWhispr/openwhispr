import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { BRAND } from '@/config/colors';

// Stable, friendly palette for guest speakers. Owner always uses the brand color.
const PALETTE = ['#FF9F0A', '#FF375F', '#BF5AF2', '#30B0C7', '#5E5CE6', '#34C759'];

function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash + name.charCodeAt(i)) % PALETTE.length;
  }
  return PALETTE[hash];
}

function initialFor(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

interface SpeakerAvatarProps {
  name: string;
  isOwner?: boolean;
  size?: number;
}

export function SpeakerAvatar({ name, isOwner = false, size = 38 }: SpeakerAvatarProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: isOwner ? BRAND : colorForName(name),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: Math.round(size * 0.4) }}>
        {initialFor(name)}
      </Text>
    </View>
  );
}
