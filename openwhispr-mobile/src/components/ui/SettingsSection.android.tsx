import React from 'react';
import {
  View,
  Platform,
  Pressable,
  TextInput,
  type TextInputProps,
  type AccessibilityState,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from './SystemIcon';
import { makeStyles, useTheme } from '@/android/ThemeProvider';
import { AppFont } from '@/android/shared/lib/fonts';

type SettingsRowProps = {
  icon: string;
  mdIcon?: LucideIconName;
  /** iOS's tile colour. Android draws every tile grey (glossy white), so it's ignored. */
  iconBg?: string;
  iconStyle?: 'tile' | 'line';
  title: string;
  description?: string;
  subtitle?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
  destructive?: boolean;
  showChevron?: boolean;
  selected?: boolean;
  accessibilityState?: AccessibilityState;
  // Shown right after the description, such as a help button.
  descriptionAccessory?: React.ReactNode;
  // Dims the icon and title and ignores taps; the description stays legible to say why.
  disabled?: boolean;
};

export function SettingsRow({
  icon,
  mdIcon,
  iconStyle = 'tile',
  title,
  description,
  subtitle,
  onPress,
  rightElement,
  destructive = false,
  showChevron = true,
  selected = false,
  accessibilityState,
  descriptionAccessory,
  disabled = false,
}: SettingsRowProps) {
  const theme = useTheme().tokens;
  const styles = useStyles();
  const android = Platform.OS === 'android';
  const isLine = iconStyle === 'line';
  const dimmed = disabled ? 'opacity-40' : '';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={disabled || (!onPress && !rightElement)}
      accessibilityState={{
        selected,
        ...accessibilityState,
        disabled: disabled || accessibilityState?.disabled,
      }}
      style={({ pressed }) => ({
        backgroundColor: selected ? theme.selFill : pressed ? theme.tile : undefined,
      })}
    >
      <View
        className={
          isLine
            ? 'flex-row items-center gap-4 px-4 py-3.5'
            : 'flex-row items-center gap-3 px-4 py-2.5'
        }
      >
        {isLine ? (
          <View className={`h-6 w-6 items-center justify-center ${dimmed}`}>
            <SystemIcon
              name={icon}
              mdName={mdIcon}
              size={22}
              color={destructive ? theme.error : theme.ink}
            />
          </View>
        ) : (
          // Glossy white: a flat grey tile with an ink glyph, whatever colour iOS gives it.
          <View style={styles.tile}>
            <SystemIcon name={icon} mdName={mdIcon} size={18} color={theme.ink} />
          </View>
        )}

        <View className={android ? 'min-w-0 flex-1' : 'flex-1'}>
          <Text
            numberOfLines={android ? undefined : 1}
            className={`text-[17px] ${dimmed}`}
            style={{ color: destructive ? theme.error : theme.ink }}
          >
            {title}
          </Text>
          {description && descriptionAccessory ? (
            <View className="mt-0.5 flex-row items-center gap-1.5">
              <Text className="flex-shrink text-[13px]" style={styles.secondary}>
                {description}
              </Text>
              {descriptionAccessory}
            </View>
          ) : description ? (
            <Text className="mt-0.5 text-[13px]" style={styles.secondary}>
              {description}
            </Text>
          ) : null}
          {android && subtitle && !rightElement ? (
            <Text className="mt-0.5 text-[15px]" style={styles.secondary}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {!android && subtitle && !rightElement ? (
          <Text numberOfLines={1} className="text-[15px]" style={styles.secondary}>
            {subtitle}
          </Text>
        ) : null}

        {rightElement}

        {showChevron && onPress && !rightElement ? (
          <SystemIcon name="chevron.right" mdName="ChevronRight" size={13} color={theme.tertiary} />
        ) : null}
      </View>
    </Pressable>
  );
}

type SettingsTextFieldRowProps = TextInputProps & {
  icon: string;
  mdIcon?: LucideIconName;
  label?: string;
  trailing?: React.ReactNode;
};

// A text field laid out like a SettingsRow, so it sits in the same card with aligned separators.
export function SettingsTextFieldRow({
  icon,
  mdIcon,
  label,
  trailing,
  editable = true,
  style,
  ...inputProps
}: SettingsTextFieldRowProps) {
  const theme = useTheme().tokens;
  const styles = useStyles();
  if (Platform.OS === 'android') {
    return (
      <View className="min-h-[50px] flex-row items-center gap-4 px-4 py-3">
        <View className="h-6 w-6 items-center justify-center">
          <SystemIcon name={icon} mdName={mdIcon} size={22} color={theme.ink} />
        </View>
        <View className="min-w-0 flex-1">
          {label ? (
            <Text className="text-[15px]" style={styles.secondary}>
              {label}
            </Text>
          ) : null}
          <TextInput
            placeholderTextColor={theme.tertiary}
            autoCorrect={false}
            editable={editable}
            className={`min-h-[48px] py-2 text-[17px] ${editable ? '' : 'opacity-40'}`}
            style={[{ fontFamily: AppFont.regular, color: theme.ink }, style]}
            {...inputProps}
          />
          {trailing}
        </View>
      </View>
    );
  }
  return (
    <View className="min-h-[50px] flex-row items-center gap-4 px-4">
      <View className="h-6 w-6 items-center justify-center">
        <SystemIcon name={icon} mdName={mdIcon} size={22} color={theme.ink} />
      </View>
      {label ? (
        <Text className="w-[84px] text-[17px]" style={{ color: theme.ink }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={theme.tertiary}
        autoCorrect={false}
        editable={editable}
        className={`flex-1 py-3 text-[17px] ${editable ? '' : 'opacity-40'}`}
        style={[{ fontFamily: AppFont.regular, color: theme.ink }, style]}
        {...inputProps}
      />
      {trailing}
    </View>
  );
}

type SettingsSectionProps = {
  title?: string;
  borderless?: boolean;
  children: React.ReactNode;
};

export function SettingsSection({ title, borderless = false, children }: SettingsSectionProps) {
  const styles = useStyles();
  const childArray = React.Children.toArray(children);
  return (
    <View className="mb-7">
      {title ? (
        <Text className="mb-1.5 px-8 text-[13px] uppercase tracking-wider" style={styles.secondary}>
          {title}
        </Text>
      ) : null}

      <View className="mx-4" style={borderless ? undefined : styles.card}>
        <View style={styles.cardInner}>
          {childArray.map((child, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <View style={styles.divider} /> : null}
              {child}
            </React.Fragment>
          ))}
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  // Glossy white: a flat card, corners 16, inset hairline dividers.
  card: { ...t.flat, borderRadius: 16 },
  cardInner: { borderRadius: 16, overflow: 'hidden' },
  divider: { height: 1, marginLeft: 64, backgroundColor: t.tokens.hairline },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: t.tokens.tile,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondary: { color: t.tokens.secondary },
}));
