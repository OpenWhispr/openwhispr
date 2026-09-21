import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { router } from 'expo-router';
import { useAuthStore } from '@/store/useAuthStore';
import { getAccountDisplay } from '@/lib/accountDisplay';
import { safeHaptics } from '@/lib/utils';
import { GradientGlassSurface } from './GradientGlassSurface';

export function AccountAvatarButton() {
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);

  if (!user && !isGuest) return null;

  const { initials } = getAccountDisplay(user, isGuest);

  return (
    <Pressable
      onPress={() => {
        safeHaptics('selection');
        router.push('/(account)');
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Account"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View className="h-[30px] w-[30px] items-center justify-center rounded-full bg-brand">
        <GradientGlassSurface shape="circle" />
        <Text className="text-[13px] font-semibold text-white tracking-tight">
          {isGuest ? 'G' : initials}
        </Text>
      </View>
    </Pressable>
  );
}
