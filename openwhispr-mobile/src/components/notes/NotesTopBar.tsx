import { ReactNode } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SearchField } from '@/components/ui/SearchField';
import { GlassBackButton } from '@/components/ui/GlassBackButton';
import { safeHaptics } from '@/lib/utils';

type NotesTopBarProps = {
  showBack?: boolean;
  title?: string;
  rightSlots?: ReactNode;
  searchValue: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit?: () => void;
  /** When provided, renders an inline compose button next to the search bar. */
  onCompose?: () => void;
};

export function NotesTopBar({
  showBack,
  title,
  rightSlots,
  searchValue,
  onSearchChange,
  onSearchSubmit,
  onCompose,
}: NotesTopBarProps) {
  const insets = useSafeAreaInsets();
  const hasTopRow = Boolean(showBack || rightSlots || title);

  return (
    <View className="px-4" style={{ paddingTop: insets.top + 8 }}>
      {hasTopRow && (
        <View className="mb-3 min-h-[44px] flex-row items-center justify-between">
          {showBack ? <GlassBackButton fallbackRoute="/(tabs)/(notes)" /> : <View />}

          {title && (
            <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
              <Text numberOfLines={1} className="text-[17px] font-semibold text-label">
                {title}
              </Text>
            </View>
          )}

          <View className="flex-row items-center gap-4">{rightSlots}</View>
        </View>
      )}

      <View className="flex-row items-center gap-2.5">
        <SearchField
          value={searchValue}
          onChangeText={onSearchChange}
          onSubmit={onSearchSubmit}
          accessibilityLabel="Search notes"
        />

        {onCompose && (
          <Pressable
            onPress={() => {
              safeHaptics('light');
              onCompose();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New note"
            style={({ pressed }) => ({
              opacity: pressed ? 0.5 : 1,
              width: 48,
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <SystemIcon name="square.and.pencil" mdName="SquarePen" size={28} color="brand" />
          </Pressable>
        )}
      </View>
    </View>
  );
}
