import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  PlatformColor,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { SpaceGrotesk } from '@/lib/fonts';

export interface SpeakerRenameSuggestion {
  label: string;
  email?: string | null;
}

interface SpeakerRenameSheetProps {
  visible: boolean;
  initialName: string;
  suggestions?: SpeakerRenameSuggestion[];
  onCancel: () => void;
  onSave: (displayName: string) => void;
}

export function SpeakerRenameSheet({
  visible,
  initialName,
  suggestions = [],
  onCancel,
  onSave,
}: SpeakerRenameSheetProps) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  useEffect(() => {
    if (visible) setName(initialName);
  }, [initialName, visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        className="flex-1 justify-end bg-black/30"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View
          className="gap-4 rounded-t-[24px] bg-systemBackground px-5 pb-8 pt-5"
          testID="speaker-rename-sheet"
        >
          <Text className="text-lg font-semibold text-label">Rename speaker</Text>
          {suggestions.length > 0 ? (
            <View className="flex-row flex-wrap gap-2" testID="speaker-rename-suggestions">
              {suggestions.map((suggestion, index) => (
                <Pressable
                  key={`${suggestion.email ?? suggestion.label}-${index}`}
                  onPress={() => onSave(suggestion.label)}
                  className="max-w-[180px] rounded-full bg-tertiarySystemFill px-3 py-1.5"
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${suggestion.label}`}
                  testID={`speaker-rename-suggestion-${index}`}
                  style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
                >
                  <Text numberOfLines={1} className="text-[13px] font-medium text-label">
                    {suggestion.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus
            selectTextOnFocus
            placeholder="Speaker name"
            placeholderTextColor={PlatformColor('tertiaryLabel') as unknown as string}
            className="h-12 rounded-lg border border-separator bg-secondarySystemBackground px-3 text-base text-label"
            style={{ fontFamily: SpaceGrotesk.regular }}
            testID="speaker-rename-input"
          />
          <View className="flex-row gap-3">
            <Pressable
              onPress={onCancel}
              className="h-11 flex-1 items-center justify-center rounded-lg bg-tertiarySystemFill"
              accessibilityRole="button"
              accessibilityLabel="Cancel rename"
              testID="speaker-rename-cancel"
            >
              <Text className="text-[15px] font-medium text-label">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onSave(trimmed)}
              disabled={!trimmed}
              className="h-11 flex-1 items-center justify-center rounded-lg bg-brand"
              accessibilityRole="button"
              accessibilityLabel="Save speaker name"
              testID="speaker-rename-save"
              style={({ pressed }) => ({ opacity: !trimmed ? 0.4 : pressed ? 0.75 : 1 })}
            >
              <Text className="text-[15px] font-semibold text-white">Save</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
