import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { iosColor } from '@/config/colors';

const styles = StyleSheet.create({
  androidKeyboardContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  androidSheet: { maxHeight: '100%', flexShrink: 1 },
  androidForm: { flexShrink: 1 },
  androidFormContent: { gap: 16 },
});

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
  const { copy } = useAndroidCopy();
  const insets = useSafeAreaInsets();
  const isAndroid = Platform.OS === 'android';
  const FormBody = isAndroid ? ScrollView : View;
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  useEffect(() => {
    if (visible) setName(initialName);
  }, [initialName, visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent={isAndroid}
    >
      <KeyboardAvoidingView
        className={isAndroid ? undefined : 'flex-1 justify-end bg-black/30'}
        style={
          isAndroid ? [styles.androidKeyboardContainer, { paddingTop: insets.top + 8 }] : undefined
        }
        behavior="padding"
      >
        <View
          className="gap-4 rounded-t-[24px] bg-systemBackground px-5 pb-8 pt-5"
          style={isAndroid ? styles.androidSheet : undefined}
          testID="speaker-rename-sheet"
        >
          <FormBody
            className={isAndroid ? undefined : 'gap-4'}
            style={isAndroid ? styles.androidForm : undefined}
            contentContainerStyle={isAndroid ? styles.androidFormContent : undefined}
            keyboardShouldPersistTaps="handled"
          >
            <Text accessibilityRole="header" className="text-lg font-semibold text-label">
              {copy('speakerControls.renameTitle', 'Rename speaker')}
            </Text>
            {suggestions.length > 0 ? (
              <View className="flex-row flex-wrap gap-2" testID="speaker-rename-suggestions">
                {suggestions.map((suggestion, index) => (
                  <Pressable
                    key={`${suggestion.email ?? suggestion.label}-${index}`}
                    onPress={() => onSave(suggestion.label)}
                    className="max-w-[180px] rounded-full bg-tertiarySystemFill px-3 py-1.5"
                    accessibilityRole="button"
                    accessibilityLabel={copy('speakerControls.useName', `Use ${suggestion.label}`, {
                      name: suggestion.label,
                    })}
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
              placeholder={copy('speakerControls.namePlaceholder', 'Speaker name')}
              placeholderTextColor={iosColor('tertiaryLabel')}
              className={
                Platform.OS === 'android'
                  ? 'min-h-12 rounded-lg border border-separator bg-secondarySystemBackground px-3 py-2 text-base text-label'
                  : 'h-12 rounded-lg border border-separator bg-secondarySystemBackground px-3 text-base text-label'
              }
              style={{ fontFamily: AppFont.regular }}
              testID="speaker-rename-input"
            />
          </FormBody>
          <View className="flex-row gap-3">
            <Pressable
              onPress={onCancel}
              className={
                Platform.OS === 'android'
                  ? 'min-h-12 flex-1 items-center justify-center rounded-lg bg-tertiarySystemFill px-3 py-3'
                  : 'h-11 flex-1 items-center justify-center rounded-lg bg-tertiarySystemFill'
              }
              accessibilityRole="button"
              accessibilityLabel={copy('speakerControls.cancelRename', 'Cancel rename')}
              testID="speaker-rename-cancel"
            >
              <Text className="text-[15px] font-medium text-label">{copy('cancel', 'Cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => onSave(trimmed)}
              disabled={!trimmed}
              className={
                Platform.OS === 'android'
                  ? 'min-h-12 flex-1 items-center justify-center rounded-lg bg-brand px-3 py-3'
                  : 'h-11 flex-1 items-center justify-center rounded-lg bg-brand'
              }
              accessibilityRole="button"
              accessibilityLabel={copy('speakerControls.saveName', 'Save speaker name')}
              testID="speaker-rename-save"
              style={({ pressed }) => ({ opacity: !trimmed ? 0.4 : pressed ? 0.75 : 1 })}
            >
              <Text className="text-[15px] font-semibold text-white">{copy('save', 'Save')}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
