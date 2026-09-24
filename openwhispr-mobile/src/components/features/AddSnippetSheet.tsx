import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { FormSheet } from '@/components/ui/FormSheet';
import { iosColor } from '@/config/colors';
import { confirmDestructive } from '@/lib/alerts';
import { SpaceGrotesk } from '@/lib/fonts';
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
    ? 'A snippet with that trigger already exists.'
    : isTooLong
      ? `Triggers are limited to ${TRIGGER_MAX_LENGTH} characters.`
      : null;

  const handleSubmit = () => {
    if (!canSubmit) return;
    safeHaptics('light');
    onSubmit(trimmedTrigger, trimmedReplacement);
    onClose();
  };

  // Edit mode only: confirm before deleting so a tap can't remove a snippet by mistake.
  const destructiveAction =
    isEditing && onDelete
      ? {
          label: 'Delete Snippet',
          onPress: () =>
            confirmDestructive('Delete snippet?', `"${initial?.trigger}" will be deleted.`, () => {
              safeHaptics('warning');
              onDelete();
              onClose();
            }),
        }
      : undefined;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={isEditing ? 'Edit snippet' : 'Add snippet'}
      subtitle="A spoken trigger expands to its replacement text in your dictation."
      submitLabel={isEditing ? 'Save' : 'Add'}
      canSubmit={canSubmit}
      onSubmit={handleSubmit}
      destructiveAction={destructiveAction}
    >
      <Text className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-secondaryLabel">
        Trigger
      </Text>
      <View
        style={{ borderCurve: 'continuous' }}
        className="rounded-xl bg-tertiarySystemFill px-3.5 py-3"
      >
        <TextInput
          ref={triggerRef}
          value={trigger}
          onChangeText={setTrigger}
          placeholder="e.g. signoff"
          placeholderTextColor={PLACEHOLDER_COLOR}
          maxLength={TRIGGER_MAX_LENGTH}
          returnKeyType="next"
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.input}
        />
      </View>

      <Text className="mb-1.5 mt-4 text-[12px] font-medium uppercase tracking-wider text-secondaryLabel">
        Replacement
      </Text>
      <View
        style={{ borderCurve: 'continuous' }}
        className="rounded-xl bg-tertiarySystemFill px-3.5 py-3"
      >
        <TextInput
          value={replacement}
          onChangeText={setReplacement}
          placeholder="e.g. Best regards, Alex"
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
    fontFamily: SpaceGrotesk.regular,
    fontSize: 15,
    fontWeight: '400',
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
});
