import { useTranslation } from 'react-i18next';
import { createSwipeableCard, type SwipeableCardPresentation } from './SwipeableCardCore';

export type { RestoreRow } from './SwipeableCardCore';

function useAndroidSwipePresentation(): SwipeableCardPresentation {
  const { t } = useTranslation();
  return {
    immediateDelete: true,
    moveLabel: () => t('android:moveAction', { defaultValue: 'Move' }),
    deleteLabel: () => t('android:deleteAction', { defaultValue: 'Delete' }),
    actionContainerProps: (revealed) => ({
      collapsable: false,
      accessibilityElementsHidden: !revealed,
      importantForAccessibility: revealed ? 'auto' : 'no-hide-descendants',
      pointerEvents: revealed ? 'auto' : 'none',
    }),
    actionButtonProps: (revealed) => ({
      accessible: revealed,
      focusable: revealed,
      accessibilityElementsHidden: !revealed,
      importantForAccessibility: revealed ? 'yes' : 'no-hide-descendants',
    }),
  };
}

export const SwipeableCard = createSwipeableCard(useAndroidSwipePresentation);
