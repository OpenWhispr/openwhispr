import { MenuView } from '@react-native-menu/menu';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useTheme } from '@/android/ThemeProvider';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { createFab, type FabPresentation } from './FabCore.android';

export { FAB_BOTTOM_PADDING, type FabAction } from './FabCore.android';

function useAndroidFabPresentation(): FabPresentation {
  const { t } = useTranslation('android');
  const theme = useTheme();
  // White words on blue: the accent in light, the brand glass's blue in dark (the dark accent is
  // too light under white).
  const fill = theme.scheme === 'dark' ? theme.tokens.glassBottom : theme.tokens.accent;
  const label = theme.tokens.onGlass;
  return {
    pressableProps: { cssInterop: false },
    // Hover must reach the labelled button through the decorative mark.
    markPointerEvents: 'auto',
    renderMenu: (actions, onActionPress, bottom) => {
      return (
        <View style={{ position: 'absolute', right: 20, bottom }}>
          <MenuView
            onPressAction={({ nativeEvent }) => onActionPress(nativeEvent.event)}
            actions={actions.map((action) => ({ id: action.id, title: action.label }))}
            shouldOpenOnLongPress={false}
          >
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={t('newAction')}
              style={{
                minHeight: 52,
                paddingHorizontal: 20,
                borderRadius: 18,
                backgroundColor: fill,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <SystemIcon name="plus" mdName="Plus" size={22} color={label} />
              <Text style={{ color: label, fontSize: 17, fontWeight: '600' }}>
                {t('newAction')}
              </Text>
            </View>
          </MenuView>
        </View>
      );
    },
  };
}

export const Fab = createFab(useAndroidFabPresentation);
