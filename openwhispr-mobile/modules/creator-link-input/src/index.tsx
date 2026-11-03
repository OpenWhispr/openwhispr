import { useState } from 'react';
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import {
  Platform,
  PlatformColor,
  TextInput,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';

type InputEvent = {
  text: string;
  source: 'edit' | 'paste' | 'submit' | 'tooLong';
  eventCount: number;
};
type Props = {
  value: string;
  editable: boolean;
  fontFamily: string;
  onChangeText: (text: string) => void;
  onPaste: (text: string) => void;
  onSubmit: (text: string) => void;
  onInvalidPaste: () => void;
};
// A JS update can reach a binary built before this module; use the plain field there.
const NativeInput =
  Platform.OS === 'ios' && requireOptionalNativeModule('CreatorLinkInput')
    ? requireNativeView<
        ViewProps & {
          value: string;
          editable: boolean;
          fontFamily: string;
          mostRecentEventCount: number;
          onInput: (event: NativeSyntheticEvent<InputEvent>) => void;
        }
      >('CreatorLinkInput')
    : null;

export function CreatorLinkInput({
  value,
  editable,
  fontFamily,
  onChangeText,
  onPaste,
  onSubmit,
  onInvalidPaste,
}: Props) {
  const [eventCount, setEventCount] = useState(0);
  const { fontScale } = useWindowDimensions();
  if (!NativeInput) {
    return (
      <TextInput
        value={value}
        editable={editable}
        onChangeText={onChangeText}
        onSubmitEditing={(event) => onSubmit(event.nativeEvent.text)}
        accessibilityLabel="Creator code or link"
        placeholder="Enter a creator code or link"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        maxLength={2048}
        placeholderTextColor={PlatformColor('tertiaryLabel')}
        style={{
          minHeight: 50,
          padding: 12,
          fontFamily,
          fontSize: 16,
          color: PlatformColor('label'),
        }}
      />
    );
  }
  return (
    <NativeInput
      value={value}
      editable={editable}
      fontFamily={fontFamily}
      mostRecentEventCount={eventCount}
      style={{ height: Math.max(50, 22 * fontScale + 24) }}
      onInput={({ nativeEvent }) => {
        setEventCount(nativeEvent.eventCount);
        if (!editable) return;
        if (nativeEvent.source === 'paste') onPaste(nativeEvent.text);
        else if (nativeEvent.source === 'submit') onSubmit(nativeEvent.text);
        else if (nativeEvent.source === 'tooLong') onInvalidPaste();
        else onChangeText(nativeEvent.text);
      }}
    />
  );
}
