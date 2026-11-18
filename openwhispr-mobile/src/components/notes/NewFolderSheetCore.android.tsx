import { useEffect, useRef, useState } from 'react';
import { PlatformColor, TextInput } from 'react-native';
import { FormSheet } from '@/components/ui/FormSheet';
import { AppFont } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { NOTES_BUTTON_RADIUS } from './tokens';

type NewFolderSheetProps = {
  visible: boolean;
  initialName?: string;
  onClose: () => void;
  onCreate: (name: string) => void;
};

export type NewFolderPresentation = {
  initialName?: string;
  title?: string;
  submitLabel?: string;
  placeholder?: string;
  placeholderTextColor?: string;
  backgroundColor?: string;
};

export function createNewFolderSheet(
  usePresentation: (initialName?: string) => NewFolderPresentation = () => ({}),
) {
  return function NewFolderSheet({ visible, onClose, onCreate, initialName }: NewFolderSheetProps) {
    const presentation = usePresentation(initialName);
    const prefilledName = presentation.initialName;
    const inputRef = useRef<TextInput>(null);
    const [name, setName] = useState('');

    useEffect(() => {
      if (!visible) return;
      setName(prefilledName ?? '');
      // Slight delay so the sheet's slide-in finishes before the keyboard rises.
      const focusTimer = setTimeout(() => inputRef.current?.focus(), 220);
      return () => clearTimeout(focusTimer);
    }, [visible, prefilledName]);

    const trimmed = name.trim();
    const canCreate = trimmed.length > 0;

    const handleCreate = () => {
      if (!canCreate) return;
      safeHaptics('success');
      onCreate(trimmed);
      onClose();
    };

    return (
      <FormSheet
        visible={visible}
        onClose={onClose}
        title={presentation.title ?? 'New Folder'}
        submitLabel={presentation.submitLabel ?? 'Create Folder'}
        canSubmit={canCreate}
        onSubmit={handleCreate}
      >
        <TextInput
          ref={inputRef}
          value={name}
          onChangeText={setName}
          placeholder={presentation.placeholder ?? 'Folder name'}
          placeholderTextColor={
            presentation.placeholderTextColor ??
            (PlatformColor('tertiaryLabel') as unknown as string)
          }
          returnKeyType="done"
          onSubmitEditing={handleCreate}
          autoCapitalize="sentences"
          className="h-12 px-3 text-[17px] text-label"
          style={{
            backgroundColor:
              presentation.backgroundColor ??
              (PlatformColor('tertiarySystemFill') as unknown as string),
            borderRadius: NOTES_BUTTON_RADIUS,
            borderCurve: 'continuous',
            fontFamily: AppFont.regular,
          }}
        />
      </FormSheet>
    );
  };
}
