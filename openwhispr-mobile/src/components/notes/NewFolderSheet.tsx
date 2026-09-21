import { useEffect, useRef, useState } from 'react';
import { PlatformColor, TextInput } from 'react-native';
import { FormSheet } from '@/components/ui/FormSheet';
import { SpaceGrotesk } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { NOTES_BUTTON_RADIUS } from './tokens';

type NewFolderSheetProps = {
  visible: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
};

export function NewFolderSheet({ visible, onClose, onCreate }: NewFolderSheetProps) {
  const inputRef = useRef<TextInput>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!visible) return;
    setName('');
    // Slight delay so the sheet's slide-in finishes before the keyboard rises.
    const t = setTimeout(() => inputRef.current?.focus(), 220);
    return () => clearTimeout(t);
  }, [visible]);

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
      title="New Folder"
      submitLabel="Create Folder"
      canSubmit={canCreate}
      onSubmit={handleCreate}
    >
      <TextInput
        ref={inputRef}
        value={name}
        onChangeText={setName}
        placeholder="Folder name"
        placeholderTextColor={PlatformColor('tertiaryLabel') as unknown as string}
        returnKeyType="done"
        onSubmitEditing={handleCreate}
        autoCapitalize="sentences"
        className="h-12 px-3 text-[17px] text-label"
        style={{
          backgroundColor: PlatformColor('tertiarySystemFill') as unknown as string,
          borderRadius: NOTES_BUTTON_RADIUS,
          borderCurve: 'continuous',
          fontFamily: SpaceGrotesk.regular,
        }}
      />
    </FormSheet>
  );
}
