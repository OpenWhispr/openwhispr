import { MenuView } from '@react-native-menu/menu';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { palette } from '@/android/ui';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { createFab, type FabPresentation } from './FabCore';

export { FAB_BOTTOM_PADDING, type FabAction } from './FabCore';

function useAndroidFabPresentation(): FabPresentation {
  const { t } = useTranslation('android');
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
                backgroundColor: palette.blue,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <SystemIcon name="plus" mdName="Plus" size={22} color="#FFFFFF" />
              <Text style={{ color: '#FFFFFF', fontSize: 17, fontWeight: '600' }}>
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
