import React, { useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { AppFont } from '@/lib/fonts';
import { useNotesLook } from '../notes/look';

/** A 48 field with the glass edge; the hairline turns brand blue while it has focus. */
export function Field({
  inputRef,
  multiline,
  style,
  ...props
}: TextInputProps & { inputRef?: React.Ref<TextInput> }) {
  const n = useNotesLook();
  const k = n.theme.tokens;
  // The accent at 55%: the hairline of a field that has focus.
  const focusRing = n.theme.scheme === 'dark' ? 'rgba(110,155,255,0.55)' : 'rgba(21,85,212,0.55)';
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={inputRef}
      placeholderTextColor={k.tertiary}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        props.onBlur?.(event);
      }}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      style={[
        n.edgeField,
        {
          minHeight: multiline ? 96 : 48,
          paddingHorizontal: 16,
          paddingVertical: multiline ? 12 : 0,
          fontSize: 17,
          color: k.ink,
          fontFamily: AppFont.regular,
        },
        focused && { borderColor: focusRing, borderWidth: 1.5 },
        style,
      ]}
      {...props}
    />
  );
}
