import React, { useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { AppFont } from '@/lib/fonts';
import { theme } from '../theme';
import { edgeField } from '../settings/look';

/** The accent at 55%: the hairline of a field that has focus. */
const FOCUS_RING = 'rgba(21,85,212,0.55)';

/** A 48 field with the glass edge; the hairline turns brand blue while it has focus. */
export function Field({
  inputRef,
  multiline,
  style,
  ...props
}: TextInputProps & { inputRef?: React.Ref<TextInput> }) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={inputRef}
      placeholderTextColor={theme.tertiary}
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
        edgeField,
        {
          minHeight: multiline ? 96 : 48,
          paddingHorizontal: 16,
          paddingVertical: multiline ? 12 : 0,
          fontSize: 17,
          color: theme.ink,
          fontFamily: AppFont.regular,
        },
        focused && { borderColor: FOCUS_RING, borderWidth: 1.5 },
        style,
      ]}
      {...props}
    />
  );
}
