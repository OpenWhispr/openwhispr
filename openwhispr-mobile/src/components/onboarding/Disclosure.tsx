import { useState, type ReactNode } from 'react';
import { LayoutAnimation, Platform, Pressable, UIManager, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface DisclosureProps {
  title: string;
  children: ReactNode;
}

/** Tappable header that expands to reveal supporting detail — used for
 * progressive disclosure of explanations the user can opt into. */
export function Disclosure({ title, children }: DisclosureProps) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((value) => !value);
  };

  return (
    <View className="overflow-hidden rounded-xl border border-separator bg-secondarySystemGroupedBackground">
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center justify-between px-4 py-3 active:opacity-80"
      >
        <Text className="flex-1 pr-3 text-[15px] font-semibold text-label">{title}</Text>
        <SystemIcon
          name={open ? 'chevron.up' : 'chevron.down'}
          mdName={open ? 'ChevronUp' : 'ChevronDown'}
          size={15}
          color="secondaryLabel"
        />
      </Pressable>
      {open ? <View className="px-4 pb-4">{children}</View> : null}
    </View>
  );
}
