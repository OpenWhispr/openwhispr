import { useEffect, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Tabs } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useHomeT } from './home/strings';
import { home } from './home/kit';
import { useNavigationBarCanvas } from './navigationBar';
import {
  shouldShowTabBar,
  tabColors,
  tabLabelProps,
  TAB_BAR_HEIGHT,
  type TabRoute,
} from './tabBar';

const ICONS: Record<string, { sf: string; md: LucideIconName }> = {
  '(record)': { sf: 'house', md: 'House' },
  '(notes)': { sf: 'note.text', md: 'Notebook' },
  '(dictionary)': { sf: 'book', md: 'BookOpen' },
  '(style)': { sf: 'sparkles', md: 'Sparkles' },
};

function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/** Material navigation bar on the page colour: no top line, no shadow, a tinted pill. */
export function AndroidTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const h = useHomeT();
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const focused = state.routes[state.index];
  const hiddenByOptions =
    (StyleSheet.flatten(descriptors[focused.key]?.options.tabBarStyle) as ViewStyle | undefined)
      ?.display === 'none';
  const visible = shouldShowTabBar({ route: focused as TabRoute, keyboardShown, hiddenByOptions });
  // The system bar takes the colour of the surface it touches: white under the bar, the page
  // colour on pushed screens and with the keyboard up.
  useNavigationBarCanvas(visible ? tabColors.bar : home.canvas);
  if (!visible) return null;

  const tabs = state.routes.filter((route) => ICONS[route.name]);
  return (
    <View
      testID="tab-bar"
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        minHeight: TAB_BAR_HEIGHT + insets.bottom,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: tabColors.bar,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: tabColors.hairline,
      }}
    >
      {tabs.map((route, position) => {
        const selected = route.key === focused.key;
        const { options } = descriptors[route.key];
        const label = String(options.title ?? route.name);
        const icon = ICONS[route.name];
        const text = tabLabelProps(selected);
        const onPress = () => {
          // Native stacks pop to their first screen on this event, and a first screen that
          // registered useScrollToTop scrolls up.
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!selected && !event.defaultPrevented)
            navigation.dispatch({ ...CommonActions.navigate(route), target: state.key });
        };
        return (
          <Pressable
            key={route.key}
            testID={`tab-${route.name}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${label}, ${h('tabPosition', { index: position + 1, count: tabs.length })}`}
            onPress={onPress}
            onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            style={{
              flex: 1,
              minHeight: 48,
              alignItems: 'center',
              paddingTop: 12,
              paddingBottom: 16,
              paddingHorizontal: 2,
              gap: 4,
            }}
          >
            <View style={{ width: 56, height: 32, alignItems: 'center', justifyContent: 'center' }}>
              {/* Mounted rather than recoloured: Android drops the rounding when a view's
                  background changes from transparent to a colour. */}
              {selected && (
                <View
                  testID="tab-pill"
                  style={{
                    ...StyleSheet.absoluteFillObject,
                    borderRadius: 16,
                    backgroundColor: tabColors.pill,
                  }}
                />
              )}
              <SystemIcon
                name={icon.sf}
                mdName={icon.md}
                size={24}
                color={selected ? tabColors.iconSelected : tabColors.icon}
              />
            </View>
            <Text {...text} style={[text.style, { alignSelf: 'stretch' }]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function AndroidTabs() {
  const { t } = useTranslation();
  return (
    <Tabs tabBar={(props) => <AndroidTabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="(record)" options={{ title: t('home') }} />
      <Tabs.Screen name="(notes)" options={{ title: t('notes') }} />
      {/* Chat isn't part of the Android beta. The route stays registered for iOS, so hide it. */}
      <Tabs.Screen name="(chat)" options={{ href: null }} />
      <Tabs.Screen name="(dictionary)" options={{ title: t('dictionary') }} />
      <Tabs.Screen name="(style)" options={{ title: t('style') }} />
    </Tabs>
  );
}
