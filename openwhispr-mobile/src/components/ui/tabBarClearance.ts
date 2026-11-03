import { Platform } from 'react-native';

// Approximate height of the floating NativeTabs bar (incl. home-indicator inset). Tab screens draw
// under it, so content pinned to their bottom sits this far up.
export const TAB_BAR_CLEARANCE = Platform.OS === 'ios' ? 110 : 70;
