import React, { Children, isValidElement, ReactNode } from 'react';
import { View, Pressable, type PressableProps } from 'react-native';
import { useTheme } from '@/android/ThemeProvider';
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

type GroupedListRowProps = Pick<
  PressableProps,
  'accessibilityActions' | 'onAccessibilityAction'
> & {
  leadingIconSlot?: ReactNode;
  contentInsetLeft?: number;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: 'button';
  testID?: string;
  children: ReactNode;
};

type RowAccessibility = Pick<PressableProps, 'accessibilityActions' | 'onAccessibilityAction'>;

export function createGroupedList(
  rowAccessibility: (props: RowAccessibility) => RowAccessibility = () => ({}),
) {
  function Row({
    leadingIconSlot,
    contentInsetLeft = NOTES_ROW_CONTENT_INSET,
    onPress,
    onLongPress,
    disabled,
    accessibilityLabel,
    accessibilityRole,
    accessibilityActions,
    onAccessibilityAction,
    testID,
    children,
  }: GroupedListRowProps) {
    const { scheme } = useTheme();
    // A pressed row: notes' pressedRow wash.
    const pressedFill = scheme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
    return (
      <Pressable
        // An accessible row hides nested controls from VoiceOver, so only pressable rows group.
        accessible={Boolean(onPress || onLongPress)}
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        {...rowAccessibility({ accessibilityActions, onAccessibilityAction })}
        accessibilityState={disabled === undefined ? undefined : { disabled }}
        testID={testID}
        cssInterop={false}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: NOTES_ROW_PADDING_X,
          paddingVertical: NOTES_ROW_PADDING_Y,
          backgroundColor: pressed ? pressedFill : 'transparent',
        })}
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

  function GroupedList({
    radius = NOTES_GROUP_RADIUS,
    dividerInset = NOTES_ROW_CONTENT_INSET,
    tinted = false,
    children,
  }: GroupedListProps) {
    const { scheme, tokens } = useTheme();
    const { surface, divider } = tokens;
    const dark = scheme === 'dark';
    const rows = Children.toArray(children).filter(isValidElement);
    // Same border width in both looks: only its colour changes with `tinted`.
    const corners = { borderRadius: radius, borderCurve: 'continuous' as const };
    return (
      <View
        style={[
          corners,
          {
            backgroundColor: surface,
            boxShadow: dark ? '0px 2px 8px rgba(0, 0, 0, 0.35)' : '0px 2px 8px rgba(0, 0, 0, 0.10)',
          },
        ]}
      >
        <View
          style={[
            corners,
            {
              overflow: 'hidden',
              borderWidth: tinted ? 1 : 0,
              borderColor: divider,
              backgroundColor: tinted ? undefined : surface,
            },
          ]}
        >
          {rows.map((row, i) => (
            <React.Fragment key={i}>
              {row}
              {i < rows.length - 1 && (
                <View style={{ height: 1, backgroundColor: divider, marginLeft: dividerInset }} />
              )}
            </React.Fragment>
          ))}
        </View>
      </View>
    );
  }

  GroupedList.Row = Row;
  return GroupedList;
}
