import { Modal, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';

interface VoiceprintSuggestionSheetProps {
  visible: boolean;
  speakerName: string;
  onConfirm: () => void;
  onReject: () => void;
  onRename: () => void;
  onMerge: () => void;
  onCancel: () => void;
}

export function VoiceprintSuggestionSheet({
  visible,
  speakerName,
  onConfirm,
  onReject,
  onRename,
  onMerge,
  onCancel,
}: VoiceprintSuggestionSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable className="flex-1 justify-end bg-black/30" onPress={onCancel}>
        <Pressable
          className="gap-4 rounded-t-[24px] bg-systemBackground px-5 pb-8 pt-5"
          onPress={(event) => event.stopPropagation()}
          testID="voiceprint-suggestion-sheet"
        >
          <View className="gap-1">
            <Text className="text-lg font-semibold text-label">{speakerName}</Text>
            <Text className="text-[14px] leading-5 text-secondaryLabel">
              Confirm this suggestion to lock the speaker label on this transcript.
            </Text>
          </View>
          <View className="gap-3">
            <Button onPress={onConfirm} testID="voiceprint-suggestion-confirm">
              Confirm
            </Button>
            <Button variant="secondary" onPress={onReject} testID="voiceprint-suggestion-reject">
              Reject
            </Button>
          </View>
          <View className="flex-row gap-3">
            <Button variant="secondary" className="flex-1" onPress={onRename}>
              Rename
            </Button>
            <Button variant="secondary" className="flex-1" onPress={onMerge}>
              Merge
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
