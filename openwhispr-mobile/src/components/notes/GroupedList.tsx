import React, { Children, isValidElement, ReactNode } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import {
  NOTES_GROUP_RADIUS,
  NOTES_ROW_CONTENT_INSET,
  NOTES_ROW_PADDING_X,
  NOTES_ROW_PADDING_Y,
} from './tokens';

type GroupedListProps = {
  radius?: number;
  /** Left inset of dividers between rows. Defaults to the icon-column width;
   * override (e.g. to NOTES_ROW_PADDING_X) when rows have no leading icon. */
  dividerInset?: number;
  /** Use a subtle tinted fill instead of the default opaque card bg. */
  tinted?: boolean;
  children: ReactNode;
};

type GroupedListRowProps = {
  leadingIconSlot?: ReactNode;
  contentInsetLeft?: number;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: 'button';
  testID?: string;
  children: ReactNode;
};

function Row({
  leadingIconSlot,
  contentInsetLeft = NOTES_ROW_CONTENT_INSET,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityRole,
  testID,
  children,
}: GroupedListRowProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      className="flex-row items-center active:bg-tertiarySystemFill"
      style={{
        paddingHorizontal: NOTES_ROW_PADDING_X,
        paddingVertical: NOTES_ROW_PADDING_Y,
      }}
    >
      {leadingIconSlot != null && (
        <View
          className="items-start justify-center"
          style={{ width: contentInsetLeft - NOTES_ROW_PADDING_X }}
        >
          {leadingIconSlot}
        </View>
      )}
      <View className="min-w-0 flex-1">{children}</View>
    </Pressable>
  );
}

export function GroupedList({
  radius = NOTES_GROUP_RADIUS,
  dividerInset = NOTES_ROW_CONTENT_INSET,
  tinted = false,
  children,
}: GroupedListProps) {
  const rows = Children.toArray(children).filter(isValidElement);
  const containerClass = tinted
    ? 'overflow-hidden border border-separator'
    : 'overflow-hidden bg-secondarySystemGroupedBackground';

  const radiusStyle = { borderRadius: radius };
  return (
    <View
      className="bg-secondarySystemGroupedBackground"
      style={[styles.shadow, styles.continuous, radiusStyle]}
    >
      <View
        className={containerClass}
        style={[!tinted && styles.opaqueBackground, styles.continuous, radiusStyle]}
      >
        {rows.map((row, i) => (
          <React.Fragment key={i}>
            {row}
            {i < rows.length - 1 && (
              <View className="h-px bg-separator" style={{ marginLeft: dividerInset }} />
            )}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

GroupedList.Row = Row;

const styles = StyleSheet.create({
  opaqueBackground: {
    backgroundColor: '#FFFFFF',
  },
  shadow: {
    boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.10)',
  },
  continuous: {
    borderCurve: 'continuous',
  },
});
