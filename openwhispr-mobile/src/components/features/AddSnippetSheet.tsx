import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { FormSheet } from '@/components/ui/FormSheet';
import { iosColor } from '@/config/colors';
import { confirmDestructive } from '@/lib/alerts';
import { AppFont } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import type { Snippet } from '@/lib/snippets';

const LABEL_COLOR = iosColor('label');
const PLACEHOLDER_COLOR = iosColor('tertiaryLabel');

// Matches desktop's SnippetsView trigger cap.
const TRIGGER_MAX_LENGTH = 80;

type Props = {
  visible: boolean;
  onClose: () => void;
  // The snippet being edited, or null/undefined to create a new one.
  initial?: Snippet | null;
  // Lowercased triggers already in use, EXCLUDING the one being edited — for
  // case-insensitive duplicate rejection.
  existingTriggers: string[];
  onSubmit: (trigger: string, replacement: string) => void;
  // Remove the snippet being edited. Only invoked from edit mode, after confirmation.
  onDelete?: () => void;
};

export function AddSnippetSheet({
  visible,
  onClose,
  initial,
  existingTriggers,
  onSubmit,
  onDelete,
}: Props) {
  const { copy } = useAndroidCopy();
  const [trigger, setTrigger] = useState('');
  const [replacement, setReplacement] = useState('');
  const triggerRef = useRef<TextInput>(null);
  const isEditing = !!initial;

  useEffect(() => {
    if (visible) {
      setTrigger(initial?.trigger ?? '');
      setReplacement(initial?.replacement ?? '');
      const t = setTimeout(() => triggerRef.current?.focus(), 120);
      return () => clearTimeout(t);
    }
  }, [visible, initial]);

  const trimmedTrigger = trigger.trim();
  const trimmedReplacement = replacement.trim();
  const isDuplicate = existingTriggers.includes(trimmedTrigger.toLowerCase());
  const isTooLong = trimmedTrigger.length > TRIGGER_MAX_LENGTH;
  const canSubmit =
    trimmedTrigger.length > 0 && trimmedReplacement.length > 0 && !isDuplicate && !isTooLong;

  const error = isDuplicate
    ? copy('library.duplicateTrigger', 'A snippet with that trigger already exists.')
    : isTooLong
      ? copy('library.triggerLimit', `Triggers are limited to ${TRIGGER_MAX_LENGTH} characters.`, {
          count: TRIGGER_MAX_LENGTH,
        })
      : null;

  const handleSubmit = () => {
    if (!canSubmit) return;
    safeHaptics('light');
    onSubmit(trimmedTrigger, trimmedReplacement);
    onClose();
  };

  const handleClose = () => {
    if (trigger === (initial?.trigger ?? '') && replacement === (initial?.replacement ?? '')) {
      onClose();
      return;
    }
    confirmDestructive(
      copy('library.discardTitle', 'Discard changes?'),
      copy('library.discardBody', 'Your snippet changes have not been saved.'),
      onClose,
      {
        destructiveLabel: copy('library.discard', 'Discard'),
        cancelLabel: copy('cancel', 'Cancel'),
      },
    );
    return false;
  };

  // Edit mode only: confirm before deleting so a tap can't remove a snippet by mistake.
  const destructiveAction =
    isEditing && onDelete
      ? {
          label: copy('library.deleteSnippet', 'Delete Snippet'),
          onPress: () =>
            confirmDestructive(
              copy('library.deleteSnippet', 'Delete snippet?'),
              copy('library.deleteNamed', `"${initial?.trigger}" will be deleted.`, {
                name: initial?.trigger,
              }),
              () => {
                safeHaptics('warning');
                onDelete();
                onClose();
              },
              {
                cancelLabel: copy('cancel', 'Cancel'),
                destructiveLabel: copy('deleteAction', 'Delete'),
              },
            ),
        }
      : undefined;

  return (
    <FormSheet
      visible={visible}
      onClose={handleClose}
      title={
        isEditing
          ? copy('library.editSnippet', 'Edit snippet')
          : copy('library.addSnippet', 'Add snippet')
      }
      subtitle={copy(
        'library.snippetDescription',
        'A spoken trigger expands to its replacement text in your dictation.',
      )}
      submitLabel={isEditing ? copy('save', 'Save') : copy('library.add', 'Add')}
      canSubmit={canSubmit}
      onSubmit={handleSubmit}
      destructiveAction={destructiveAction}
    >
      <Text className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-secondaryLabel">
        {copy('library.trigger', 'Trigger')}
      </Text>
      <View
        style={{ borderCurve: 'continuous' }}
        className="rounded-xl bg-tertiarySystemFill px-3.5 py-3"
      >
        <TextInput
          ref={triggerRef}
          value={trigger}
          onChangeText={setTrigger}
          placeholder={copy('library.triggerExample', 'e.g. signoff')}
          accessibilityLabel={copy('library.trigger', 'Trigger')}
          placeholderTextColor={PLACEHOLDER_COLOR}
          maxLength={TRIGGER_MAX_LENGTH}
          returnKeyType="next"
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.input}
        />
      </View>

      <Text className="mb-1.5 mt-4 text-[12px] font-medium uppercase tracking-wider text-secondaryLabel">
        {copy('library.replacement', 'Replacement')}
      </Text>
      <View
        style={{ borderCurve: 'continuous' }}
        className="rounded-xl bg-tertiarySystemFill px-3.5 py-3"
      >
        <TextInput
          value={replacement}
          onChangeText={setReplacement}
          placeholder={copy('library.replacementExample', 'e.g. Best regards, Alex')}
          accessibilityLabel={copy('library.replacement', 'Replacement')}
          placeholderTextColor={PLACEHOLDER_COLOR}
          multiline
          style={[styles.input, styles.multiline]}
        />
      </View>

      {error ? <Text className="mt-3 text-[12px] text-systemRed">{error}</Text> : null}
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  input: {
    color: LABEL_COLOR,
    fontFamily: AppFont.regular,
    fontSize: 15,
    fontWeight: '400',
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
});
