type GoogleCalendarConfigModule = typeof import('../googleCalendarConfig');

const ORIGINAL_ENV = process.env;

const loadGoogleCalendarConfig = (expoConfig: unknown): GoogleCalendarConfigModule => {
  jest.resetModules();
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig },
  }));
  jest.doMock('expo-auth-session', () => ({
    makeRedirectUri: jest.fn(({ scheme, path }: { scheme: string; path?: string }) =>
      path ? `${scheme}://${path}` : `${scheme}://`,
    ),
  }));
  return require('../googleCalendarConfig') as GoogleCalendarConfigModule;
};

describe('googleCalendarConfig', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
    jest.dontMock('expo-constants');
    jest.dontMock('expo-auth-session');
  });

  it('prefers the app-config-resolved iOS client id over stray DEV env values', () => {
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_CLIENT_ID_DEV =
      'dev-client.apps.googleusercontent.com';
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_CLIENT_ID =
      'prod-env-client.apps.googleusercontent.com';
    const config = loadGoogleCalendarConfig({
      extra: {
        openWhispr: {
          googleCalendar: {
            iosClientId: 'prod-extra-client.apps.googleusercontent.com',
            iosClientIdDev: 'dev-extra-client.apps.googleusercontent.com',
          },
        },
      },
    });

    expect(config.getGoogleCalendarClientId()).toBe('prod-extra-client.apps.googleusercontent.com');
  });

  it('uses the configured Google iOS redirect URI exactly', () => {
    const config = loadGoogleCalendarConfig({
      extra: {
        openWhispr: {
          googleCalendar: {
            iosClientId: '123.apps.googleusercontent.com',
            iosRedirectUri: 'com.googleusercontent.apps.123:/oauth2redirect',
          },
        },
      },
    });

    expect(config.getGoogleCalendarRedirectUri()).toBe(
      'com.googleusercontent.apps.123:/oauth2redirect',
    );
  });

  it('derives a Google iOS redirect URI from the resolved client id before app-scheme fallback', () => {
    const config = loadGoogleCalendarConfig({
      scheme: 'openwhispr',
      extra: {
        openWhispr: {
          scheme: 'openwhispr',
          googleCalendar: {
            iosClientId: '123-abc.apps.googleusercontent.com',
          },
        },
      },
    });

    expect(config.getGoogleCalendarRedirectUri()).toBe(
      'com.googleusercontent.apps.123-abc:/oauth2redirect',
    );
  });
});
