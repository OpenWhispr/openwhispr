import { Modal, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { SystemIcon } from '@/components/ui/SystemIcon';

interface Props {
  visible: boolean;
  onContinueCloud: () => void;
  onKeepWaiting: () => void;
}

export function SlowDownloadSheet({ visible, onContinueCloud, onKeepWaiting }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onKeepWaiting}>
      <Pressable className="flex-1 justify-end bg-black/40" onPress={onKeepWaiting}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-3xl bg-systemBackground px-6 pb-8 pt-3"
        >
          <View className="mb-4 h-1 w-9 self-center rounded-full bg-separator" />
          <Text className="text-[22px] font-bold text-label">Download taking a while?</Text>
          <Text className="mt-1.5 text-[15px] leading-[20px] text-secondaryLabel">
            No need to wait. Continue setup on Cloud now — we&apos;ll finish your Private download
            in the background.
          </Text>

          <View className="mt-4 rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
            <View className="flex-row items-center gap-2">
              <SystemIcon name="cloud.fill" mdName="Cloud" size={16} color="brand" />
              <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">
                Turn the Cloud toggle <Text className="font-semibold text-label">off</Text> on the
                home screen to switch to Private once it&apos;s ready.
              </Text>
            </View>
          </View>

          <View className="mt-5">
            <Button onPress={onContinueCloud} size="lg">
              Continue with Cloud for now
            </Button>
            <Pressable
              onPress={onKeepWaiting}
              className="mt-3 items-center py-2"
              accessibilityRole="button"
              accessibilityLabel="Keep waiting for download"
            >
              <Text className="text-[15px] font-medium text-secondaryLabel">Keep waiting</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
