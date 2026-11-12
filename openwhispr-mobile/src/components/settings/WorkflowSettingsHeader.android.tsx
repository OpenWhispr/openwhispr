import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { safeHaptics } from '@/lib/utils';

// Android's native toolbar truncates long workflow names at large text sizes.
// An intrinsic-height header keeps the full title and back control available.
export function WorkflowSettingsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { copy } = useAndroidCopy();
  return (
    <View className="bg-systemBackground">
      <SafeAreaView edges={['top', 'left', 'right']}>
        <View className="flex-row items-center gap-2 px-4 py-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy('back', 'Back')}
            onPress={() => {
              safeHaptics('selection');
              onBack();
            }}
            className="h-12 w-12 items-center justify-center rounded-full active:bg-tertiarySystemFill"
          >
            <SystemIcon name="chevron.left" mdName="ArrowLeft" size={22} color="label" />
          </Pressable>
          <Text
            accessibilityRole="header"
            className="min-w-0 flex-1 text-[18px] font-semibold text-label"
          >
            {title}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
