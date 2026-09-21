const baseConfig = require('./app.base.json');
const { resolveOpenWhisprEnvironment } = require('./config/openwhispr-environments');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function singleOrMany(values) {
  const result = unique(values);
  return result.length === 1 ? result[0] : result;
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deriveGoogleCalendarRedirectScheme(clientId) {
  const suffix = '.apps.googleusercontent.com';
  const trimmed = firstNonEmpty(clientId);
  if (!trimmed || !trimmed.endsWith(suffix)) return null;
  return `com.googleusercontent.apps.${trimmed.slice(0, -suffix.length)}`;
}

function createGoogleCalendarRedirectConfig(environment, clientId) {
  const devRedirectUri = firstNonEmpty(
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI_DEV,
  );
  const prodRedirectUri = firstNonEmpty(process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI);
  const devRedirectScheme = firstNonEmpty(
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_SCHEME_DEV,
  );
  const prodRedirectScheme = firstNonEmpty(
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_SCHEME,
  );
  const explicitUri = environment.isDevelopment
    ? devRedirectUri || prodRedirectUri
    : prodRedirectUri;
  const explicitScheme = environment.isDevelopment
    ? devRedirectScheme || prodRedirectScheme
    : prodRedirectScheme;
  const iosRedirectScheme =
    explicitScheme || deriveGoogleCalendarRedirectScheme(clientId) || undefined;
  const iosRedirectUri =
    explicitUri || (iosRedirectScheme ? `${iosRedirectScheme}:/oauth2redirect` : undefined);

  return { iosRedirectScheme, iosRedirectUri };
}

function createEasExtensionConfig(existingExtra, environment) {
  return {
    ...(existingExtra?.eas ?? {}),
    build: {
      ...(existingExtra?.eas?.build ?? {}),
      experimental: {
        ...(existingExtra?.eas?.build?.experimental ?? {}),
        ios: {
          ...(existingExtra?.eas?.build?.experimental?.ios ?? {}),
          appExtensions: [
            {
              targetName: 'OpenWhisprKeyboard',
              bundleIdentifier: environment.keyboardBundleIdentifier,
              entitlements: {
                'com.apple.security.application-groups': [environment.appGroupId],
              },
            },
            {
              targetName: 'OpenWhisprActivity',
              bundleIdentifier: `${environment.iosBundleIdentifier}.activity`,
              entitlements: {
                'com.apple.security.application-groups': [environment.appGroupId],
              },
            },
          ],
        },
      },
    },
  };
}

function createGoogleCalendarConfig(environment) {
  const devClientId = firstNonEmpty(process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_CLIENT_ID_DEV);
  const prodClientId = firstNonEmpty(process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_CLIENT_ID);
  const iosClientId = environment.isDevelopment ? devClientId || prodClientId : prodClientId;
  return {
    iosClientId,
    iosClientIdDev: devClientId,
    ...createGoogleCalendarRedirectConfig(environment, iosClientId),
  };
}

module.exports = () => {
  const environment = resolveOpenWhisprEnvironment();
  const expo = clone(baseConfig.expo);
  const iosInfoPlist = expo.ios?.infoPlist ?? {};
  const iosQueries = iosInfoPlist.LSApplicationQueriesSchemes ?? [];
  const googleCalendar = createGoogleCalendarConfig(environment);

  return {
    ...expo,
    name: expo.name,
    scheme: singleOrMany([environment.scheme, googleCalendar.iosRedirectScheme]),
    ios: {
      ...expo.ios,
      bundleIdentifier: environment.iosBundleIdentifier,
      entitlements: {
        ...(expo.ios?.entitlements ?? {}),
        'com.apple.security.application-groups': [environment.appGroupId],
      },
      infoPlist: {
        ...iosInfoPlist,
        CFBundleDisplayName: environment.displayName,
        LSApplicationQueriesSchemes: unique([
          ...iosQueries,
          environment.scheme,
          googleCalendar.iosRedirectScheme,
          environment.iosBundleIdentifier,
        ]),
      },
    },
    android: {
      ...expo.android,
      package: environment.androidPackage,
    },
    extra: {
      ...expo.extra,
      openWhispr: {
        ...environment,
        googleCalendar,
      },
      eas: createEasExtensionConfig(expo.extra, environment),
    },
  };
};
