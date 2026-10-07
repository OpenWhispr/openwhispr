import React from 'react';
import { View, Pressable, StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from './SystemIcon';
import { BRAND, iosColor } from '@/config/colors';
import { AppFont } from '@/lib/fonts';

type SettingsRowProps = {
  icon: string;
  mdIcon?: LucideIconName;
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
  // Shown right after the description, such as a help button.
  descriptionAccessory?: React.ReactNode;
};

export function SettingsRow({
  icon,
  mdIcon,
  iconBg = BRAND,
  iconStyle = 'tile',
  title,
  description,
  subtitle,
  onPress,
  rightElement,
  destructive = false,
  showChevron = true,
  selected = false,
  descriptionAccessory,
}: SettingsRowProps) {
  const isLine = iconStyle === 'line';
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress && !rightElement}
      accessibilityState={{ selected }}
      className={selected ? 'bg-brand/10 active:bg-brand/20' : 'active:bg-tertiarySystemFill'}
    >
      <View
        className={
          isLine
            ? 'flex-row items-center gap-4 px-4 py-3.5'
            : 'flex-row items-center gap-3 px-4 py-2.5'
        }
      >
        {isLine ? (
          <View className="h-6 w-6 items-center justify-center">
            <SystemIcon
              name={icon}
              mdName={mdIcon}
              size={22}
              color={destructive ? 'systemRed' : 'label'}
            />
          </View>
        ) : (
          <View
            style={{ backgroundColor: iconBg, borderCurve: 'continuous' }}
            className="h-7 w-7 items-center justify-center rounded-md"
          >
            <SystemIcon name={icon} mdName={mdIcon} size={15} color="#FFF" />
          </View>
        )}

        <View className="flex-1">
          <Text
            numberOfLines={1}
            className={destructive ? 'text-[17px] text-systemRed' : 'text-[17px] text-label'}
          >
            {title}
          </Text>
          {description && descriptionAccessory ? (
            <View className="mt-0.5 flex-row items-center gap-1.5">
              <Text className="flex-shrink text-[13px] text-secondaryLabel">{description}</Text>
              {descriptionAccessory}
            </View>
          ) : description ? (
            <Text className="mt-0.5 text-[13px] text-secondaryLabel">{description}</Text>
          ) : null}
        </View>

        {subtitle && !rightElement ? (
          <Text numberOfLines={1} className="text-[15px] text-secondaryLabel">
            {subtitle}
          </Text>
        ) : null}

        {rightElement}

        {showChevron && onPress && !rightElement ? (
          <SystemIcon name="chevron.right" mdName="ChevronRight" size={13} color="tertiaryLabel" />
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
  return (
    <View className="min-h-[50px] flex-row items-center gap-4 px-4">
      <View className="h-6 w-6 items-center justify-center">
        <SystemIcon name={icon} mdName={mdIcon} size={22} color="label" />
      </View>
      {label ? <Text className="w-[84px] text-[17px] text-label">{label}</Text> : null}
      <TextInput
        placeholderTextColor={iosColor('tertiaryLabel')}
        autoCorrect={false}
        editable={editable}
        className={`flex-1 py-3 text-[17px] text-label ${editable ? '' : 'opacity-40'}`}
        style={[{ fontFamily: AppFont.regular }, style]}
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
  const childArray = React.Children.toArray(children);
  return (
    <View className="mb-7">
      {title ? (
        <Text className="mb-1.5 px-8 text-[13px] uppercase tracking-wider text-secondaryLabel">
          {title}
        </Text>
      ) : null}

      <View
        className={borderless ? 'mx-4' : 'mx-4 bg-secondarySystemGroupedBackground'}
        style={borderless ? undefined : styles.cardShadow}
      >
        <View
          style={styles.cardInner}
          className={
            borderless
              ? 'overflow-hidden rounded-[14px]'
              : 'overflow-hidden rounded-[14px] border border-separator'
          }
        >
          {childArray.map((child, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <View className="ml-14 h-px bg-separator" /> : null}
              {child}
            </React.Fragment>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardShadow: {
    borderRadius: 14,
    borderCurve: 'continuous',
    boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.10)',
  },
  cardInner: {
    borderCurve: 'continuous',
  },
});
