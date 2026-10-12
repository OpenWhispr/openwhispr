import { Alert, Linking, Platform } from 'react-native';

/**
 * Hands `url` to the default browser. Resolves `true` when the OS took it and
 * `false` when it could not be opened, allowing callers to unwind any state
 * armed for an external round trip.
 */
export async function openExternal(url: string, fallbackMessage?: string): Promise<boolean> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
      return true;
    }
  } catch {
    // fall through
  }

  Alert.alert('Unable to Open', fallbackMessage ?? `Could not open ${url}.`, [
    { text: 'OK', style: 'cancel' },
  ]);
  return false;
}

export function openMail(email: string, subject: string): Promise<boolean> {
  const encoded = encodeURIComponent(subject);
  const url = `mailto:${email}?subject=${encoded}`;
  const fallback =
    Platform.OS === 'ios'
      ? `No email account is configured. Email us at ${email}.`
      : `No email app is available. Email us at ${email}.`;
  return openExternal(url, fallback);
}
