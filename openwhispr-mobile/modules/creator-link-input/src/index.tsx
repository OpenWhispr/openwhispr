import { useState } from 'react';
import { requireNativeView } from 'expo';
import {
  Platform,
  TextInput,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';
import { SpaceGrotesk } from '@/lib/fonts';

type InputEvent = {
  text: string;
  source: 'edit' | 'paste' | 'submit' | 'tooLong';
  eventCount: number;
};
type Props = {
  value: string;
  editable: boolean;
  onChangeText: (text: string) => void;
  onPaste: (text: string) => void;
  onSubmit: (text: string) => void;
  onInvalidPaste: () => void;
};
const NativeInput =
  Platform.OS === 'ios'
    ? requireNativeView<
        ViewProps & {
          value: string;
          editable: boolean;
          mostRecentEventCount: number;
          onInput: (event: NativeSyntheticEvent<InputEvent>) => void;
        }
      >('CreatorLinkInput')
    : null;

export function CreatorLinkInput({
  value,
  editable,
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
        style={{ minHeight: 50, padding: 12, fontFamily: SpaceGrotesk.regular, fontSize: 16 }}
      />
    );
  }
  return (
    <NativeInput
      value={value}
      editable={editable}
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
