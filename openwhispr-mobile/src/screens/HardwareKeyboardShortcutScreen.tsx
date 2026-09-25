import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, View } from 'react-native';
import {
  SettingsRow,
  SettingsSection,
  SettingsTextFieldRow,
} from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import {
  getNotificationStatus,
  requestNotifications,
  type NotificationStatus,
} from '@/lib/notifications';
import { LiveActivity } from '../../modules/live-activity/src';

export const SHORTCUTS_CREATE_URL = 'shortcuts://create-shortcut';
export const SHORTCUTS_APP_URL = 'shortcuts://';

// The editor deep link can be refused (it rejected from inside the app on the
// iOS 26 simulator); the Shortcuts app itself is enough, since step 2's text
// says which action to add. A rejection must never surface as an error screen.
async function openShortcuts(): Promise<void> {
  try {
    await Linking.openURL(SHORTCUTS_CREATE_URL);
  } catch {
    await Linking.openURL(SHORTCUTS_APP_URL).catch(() => undefined);
  }
}
const SUGGESTED_COMBO = '⌃⌥D';

/**
 * Setup for dictating from a hardware keyboard (plugins/hotkey-dictation).
 * iPadOS hides third-party keyboards while a hardware keyboard is attached, so
 * the path is a Shortcuts action bound to a Full Keyboard Access command, with
 * the transcript delivered on the clipboard. Apple doesn't allow deep links into
 * Accessibility settings, so steps 3 and 4 are written out.
 */
export function HardwareKeyboardShortcutScreen() {
  const [dictationMode, setDictationMode] = useState(() => LiveActivity.isDictationModeEnabled());
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus | null>(null);
  const [tryText, setTryText] = useState('');

  const refreshNotificationStatus = useCallback(() => {
    getNotificationStatus()
      .then(setNotificationStatus)
      .catch(() => setNotificationStatus('unavailable'));
  }, []);

  // Re-read on return from Settings, where a denied user may have allowed them.
  useEffect(() => {
    refreshNotificationStatus();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshNotificationStatus();
    });
    return () => subscription.remove();
  }, [refreshNotificationStatus]);

  const handleNotifications = useCallback(async () => {
    if (notificationStatus === 'denied') {
      await Linking.openSettings();
      return;
    }
    setNotificationStatus(await requestNotifications());
  }, [notificationStatus]);

  const needsNotifications =
    notificationStatus === 'undetermined' || notificationStatus === 'denied';
  const tried = tryText.trim().length > 0;

  return (
    <SettingsScreen>
      <Text className="px-4 pb-2 text-[15px] text-secondaryLabel">
        Press a key combination in any app to start dictating, press it again to stop, then press ⌘V
        to paste.
      </Text>
      <SettingsSection title="1. Dictation mode">
        <SettingsRow
          iconStyle="line"
          icon="waveform"
          mdIcon="Activity"
          title="Dictation mode"
          description="Keep this on so the shortcut starts recording instantly."
          rightElement={
            <SettingsSwitch
              testID="hardware-keyboard-dictation-mode"
              value={dictationMode}
              onValueChange={(next) => {
                LiveActivity.setDictationMode(next);
                setDictationMode(next);
              }}
            />
          }
          showChevron={false}
        />
      </SettingsSection>
      <SettingsSection title="2. Add the shortcut">
        <SettingsRow
          iconStyle="line"
          icon="square.stack.3d.up"
          mdIcon="Layers"
          title="Open Shortcuts"
          description="Add the “Toggle OpenWhispr Dictation” action, then tap Done."
          onPress={openShortcuts}
        />
      </SettingsSection>
      <SettingsSection title="3. Turn on Full Keyboard Access">
        <SettingsRow
          iconStyle="line"
          icon="keyboard"
          mdIcon="Keyboard"
          title="Settings → Accessibility → Keyboards & Typing → Full Keyboard Access"
          description="Turn the Full Keyboard Access switch on. The shortcut does nothing while it is off."
          showChevron={false}
        />
      </SettingsSection>
      <SettingsSection title="4. Assign a key combination">
        <SettingsRow
          iconStyle="line"
          icon="command"
          mdIcon="Command"
          title="Commands → Shortcuts → Toggle OpenWhispr Dictation"
          description={`Press the keys you want to use. ${SUGGESTED_COMBO} (Control-Option-D) is free by default.`}
          showChevron={false}
        />
      </SettingsSection>
      {needsNotifications ? (
        <SettingsSection title="5. Allow notifications">
          <SettingsRow
            iconStyle="line"
            icon="bell.badge"
            mdIcon="BellRing"
            title={notificationStatus === 'denied' ? 'Open Settings' : 'Allow notifications'}
            description="Shows “Copied — press ⌘V to paste” after each dictation."
            onPress={handleNotifications}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Try it">
        <SettingsTextFieldRow
          icon="text.cursor"
          mdIcon="TextCursorInput"
          placeholder={`Press ${SUGGESTED_COMBO}, speak, press it again, then ⌘V`}
          value={tryText}
          onChangeText={setTryText}
          testID="hardware-keyboard-try-it"
          trailing={
            tried ? (
              <View testID="hardware-keyboard-try-it-done">
                <SystemIcon
                  name="checkmark.circle.fill"
                  mdName="CircleCheck"
                  size={20}
                  color="systemGreen"
                />
              </View>
            ) : null
          }
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
