import { Alert, Platform } from 'react-native';
import { confirmAccountDeletion } from '../alerts';

jest.mock('../utils', () => ({ safeHaptics: jest.fn() }));

function deletionMessageOn(os: typeof Platform.OS): string {
  const previous = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    confirmAccountDeletion(async () => {});
    return String(alertSpy.mock.calls[0]?.[1]);
  } finally {
    alertSpy.mockRestore();
    Object.defineProperty(Platform, 'OS', { value: previous, configurable: true });
  }
}

test('account deletion warns that an App Store subscription keeps billing on iOS', () => {
  const message = deletionMessageOn('ios');
  expect(message).toContain('permanently deletes your OpenWhispr account');
  expect(message).toContain('does not cancel a subscription bought through the App Store');
  expect(message).not.toContain('Google Play');
});

test('account deletion warns that a Google Play subscription keeps billing on Android', () => {
  const message = deletionMessageOn('android');
  expect(message).toContain('does not cancel a subscription bought through Google Play');
  expect(message).not.toContain('App Store');
});
