import { Platform } from 'react-native';
import {
  getTrackingAuthorizationStatus,
  requestTrackingAuthorization,
} from '@/lib/trackingTransparency';

const mockIsAvailable = jest.fn();
const mockGetTrackingPermissionsAsync = jest.fn();
const mockRequestTrackingPermissionsAsync = jest.fn();

jest.mock('expo-tracking-transparency', () => ({
  isAvailable: (): boolean => mockIsAvailable(),
  getTrackingPermissionsAsync: (): Promise<{ status: string }> => mockGetTrackingPermissionsAsync(),
  requestTrackingPermissionsAsync: (): Promise<{ status: string }> =>
    mockRequestTrackingPermissionsAsync(),
}));

const originalPlatform = Platform.OS;

function setPlatform(os: 'ios' | 'android'): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform('ios');
  mockIsAvailable.mockReturnValue(true);
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
});

describe('tracking transparency', () => {
  it('skips ATT on Android without consulting the native module', async () => {
    setPlatform('android');

    await expect(getTrackingAuthorizationStatus()).resolves.toBe('notSupported');

    expect(mockIsAvailable).not.toHaveBeenCalled();
    expect(mockGetTrackingPermissionsAsync).not.toHaveBeenCalled();
  });

  it('skips ATT when the native API is unavailable', async () => {
    mockIsAvailable.mockReturnValue(false);

    await expect(getTrackingAuthorizationStatus()).resolves.toBe('notSupported');

    expect(mockGetTrackingPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['granted', 'authorized'],
    ['denied', 'denied'],
    ['undetermined', 'notDetermined'],
  ] as const)('maps the native %s status to %s', async (nativeStatus, expectedStatus) => {
    mockGetTrackingPermissionsAsync.mockResolvedValue({ status: nativeStatus });

    await expect(getTrackingAuthorizationStatus()).resolves.toBe(expectedStatus);
  });

  it('maps the result returned by the native authorization request', async () => {
    mockRequestTrackingPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(requestTrackingAuthorization()).resolves.toBe('denied');

    expect(mockRequestTrackingPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});
