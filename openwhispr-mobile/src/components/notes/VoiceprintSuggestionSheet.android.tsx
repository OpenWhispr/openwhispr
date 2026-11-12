import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
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
  const { copy } = useAndroidCopy();
  const android = Platform.OS === 'android';
  const buttonClass = android ? 'h-auto min-h-12' : undefined;
  const content = (
    <>
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-lg font-semibold text-label">
          {speakerName}
        </Text>
        <Text className="text-[14px] leading-5 text-secondaryLabel">
          {copy(
            'editorFeedback.suggestionBody',
            'Confirm this suggestion to lock the speaker label on this transcript.',
          )}
        </Text>
      </View>
      <View className="gap-3">
        <Button className={buttonClass} onPress={onConfirm} testID="voiceprint-suggestion-confirm">
          {copy('editorFeedback.suggestionConfirm', 'Confirm')}
        </Button>
        <Button
          className={buttonClass}
          variant="secondary"
          onPress={onReject}
          testID="voiceprint-suggestion-reject"
        >
          {copy('editorFeedback.suggestionReject', 'Reject')}
        </Button>
      </View>
      <View className={android ? 'gap-3' : 'flex-row gap-3'}>
        <Button variant="secondary" className={android ? buttonClass : 'flex-1'} onPress={onRename}>
          {copy('speakerControls.renameAction', 'Rename')}
        </Button>
        <Button variant="secondary" className={android ? buttonClass : 'flex-1'} onPress={onMerge}>
          {copy('speakerControls.mergeAction', 'Merge')}
        </Button>
      </View>
      {android && (
        <Button variant="ghost" className={buttonClass} onPress={onCancel}>
          {copy('cancel', 'Cancel')}
        </Button>
      )}
    </>
  );
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable className="flex-1 justify-end bg-black/30" onPress={onCancel}>
        <Pressable
          className="gap-4 rounded-t-[24px] bg-systemBackground px-5 pb-8 pt-5"
          onPress={(event) => event.stopPropagation()}
          testID="voiceprint-suggestion-sheet"
          style={android ? styles.androidSheet : undefined}
        >
          {android ? (
            <ScrollView bounces={false} contentContainerClassName="gap-4">
              {content}
            </ScrollView>
          ) : (
            content
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({ androidSheet: { maxHeight: '90%' } });
