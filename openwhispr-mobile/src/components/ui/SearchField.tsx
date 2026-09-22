import { ReactNode, forwardRef } from 'react';
import { View, TextInput, PlatformColor, type TextInputProps } from 'react-native';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SpaceGrotesk } from '@/lib/fonts';

const SEARCH_FIELD_RADIUS = 10;
const SEARCH_FIELD_HEIGHT = 48;

type SearchFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
  /** Slot rendered at the trailing edge inside the field (e.g. mic icon). */
  rightSlot?: ReactNode;
  accessibilityLabel?: string;
  returnKeyType?: TextInputProps['returnKeyType'];
  autoFocus?: boolean;
};

export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField(
  {
    value,
    onChangeText,
    placeholder = 'Search',
    onSubmit,
    rightSlot,
    accessibilityLabel = 'Search',
    returnKeyType = 'search',
    autoFocus,
  },
  ref,
) {
  return (
    <View
      style={{
        height: SEARCH_FIELD_HEIGHT,
        backgroundColor: PlatformColor('tertiarySystemFill') as unknown as string,
        borderRadius: SEARCH_FIELD_RADIUS,
        borderCurve: 'continuous',
      }}
      className="flex-1 flex-row items-center gap-2 px-2.5"
    >
      <SystemIcon name="magnifyingglass" mdName="Search" size={16} color="tertiaryLabel" />
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={PlatformColor('tertiaryLabel') as unknown as string}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmit}
        accessibilityLabel={accessibilityLabel}
        autoCorrect={false}
        autoCapitalize="none"
        autoFocus={autoFocus}
        clearButtonMode="while-editing"
        className="flex-1 py-0 text-[15px] text-label"
        style={{ fontFamily: SpaceGrotesk.regular }}
      />
      {rightSlot}
    </View>
  );
});
