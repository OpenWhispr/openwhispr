import { Platform } from 'react-native';

// iOS NativeTabs overlay the screen; Android tabs already reserve their own layout space.
export const TAB_BAR_CLEARANCE = Platform.OS === 'ios' ? 110 : 0;
