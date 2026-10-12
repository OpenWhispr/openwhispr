import { useEffect, useState } from 'react';
import { Keyboard, type KeyboardEvent, LayoutAnimation, Platform } from 'react-native';

/**
 * Tracks the on-screen keyboard height, animating changes in step with the
 * keyboard on iOS (`keyboardWillChangeFrame`). Returns 0 while the keyboard is
 * hidden, or whenever `enabled` is false — pass a sheet's `visible` flag so the
 * listeners detach and the height resets when it closes.
 */
export function useKeyboardHeight(enabled = true): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setKeyboardHeight(0);
      return;
    }

    const apply = (height: number) => (event: KeyboardEvent) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: event.duration || 250,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardHeight(height === -1 ? event.endCoordinates.height : height);
    };

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, apply(-1));
    const hideSub = Keyboard.addListener(hideEvent, apply(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [enabled]);

  return keyboardHeight;
}
