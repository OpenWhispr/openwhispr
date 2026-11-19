import React, { useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { AppFont } from '@/lib/fonts';
import { home } from '../home/kit';
import { edgeField } from '../settings/look';

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
      placeholderTextColor={home.tertiary}
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
          minHeight: multiline ? 96 : 52,
          paddingHorizontal: 16,
          paddingVertical: multiline ? 12 : 0,
          fontSize: 17,
          color: home.text,
          fontFamily: AppFont.regular,
        },
        focused && { borderColor: 'rgba(21,85,212,0.55)', borderWidth: 1.5 },
        style,
      ]}
      {...props}
    />
  );
}
