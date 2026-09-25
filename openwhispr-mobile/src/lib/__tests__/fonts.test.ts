import type { PlatformOSType } from 'react-native';

const mockGetLoadedFonts = jest.fn<string[], []>();
jest.mock('expo-font', () => ({ getLoadedFonts: () => mockGetLoadedFonts() }));

const IOS_YOWZA_FACES = [
  'Yowza-Std-Regular',
  'Yowza-Std-Medium',
  'Yowza-Std-Bold',
  'Yowza-Soft-Std-Medium',
];

// fonts.ts decides once, at import, from what the native binary embeds.
function loadFontsWith(
  embedded: string[],
  os: PlatformOSType = 'ios',
): typeof import('@/lib/fonts') {
  mockGetLoadedFonts.mockReturnValue(embedded);
  let fonts: typeof import('@/lib/fonts') | undefined;
  jest.isolateModules(() => {
    // The isolated registry has its own react-native, so set the OS on that one.
    jest.replaceProperty(require('react-native').Platform, 'OS', os);
    fonts = require('@/lib/fonts');
  });
  return fonts!;
}

describe('fonts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls back to Space Grotesk when the build has no Yowza', () => {
    const fonts = loadFontsWith([]);

    expect(fonts.AppFont.regular).toBe('SpaceGrotesk_400Regular');
    expect(fonts.fontFamilyForWeight('600')).toBe('SpaceGrotesk_600SemiBold');
    expect(fonts.displayFontFamily).toBeUndefined();
  });

  it('uses Yowza for body text and Yowza Soft for headings when embedded', () => {
    const fonts = loadFontsWith(IOS_YOWZA_FACES);

    expect(fonts.fontFamilyForWeight(undefined)).toBe('Yowza-Std-Regular');
    expect(fonts.fontFamilyForWeight('500')).toBe('Yowza-Std-Medium');
    expect(fonts.fontFamilyForWeight('bold')).toBe('Yowza-Std-Bold');
    expect(fonts.displayFontFamily).toBe('Yowza-Soft-Std-Medium');
  });

  // Yowza has no Semibold; letting 600 fall to Bold reads heavy, as on desktop.
  it('maps semibold to Yowza Medium', () => {
    const fonts = loadFontsWith(IOS_YOWZA_FACES);

    expect(fonts.fontFamilyForWeight('600')).toBe('Yowza-Std-Medium');
  });

  it('keeps Space Grotesk when only some Yowza faces are embedded', () => {
    const fonts = loadFontsWith(IOS_YOWZA_FACES.slice(0, 2));

    expect(fonts.AppFont.regular).toBe('SpaceGrotesk_400Regular');
    expect(fonts.displayFontFamily).toBeUndefined();
  });

  it('names embedded faces by file name on Android', () => {
    const fonts = loadFontsWith(
      IOS_YOWZA_FACES.map((face) => face.toLowerCase()),
      'android',
    );

    expect(fonts.AppFont.regular).toBe('yowza-std-regular');
    expect(fonts.displayFontFamily).toBe('yowza-soft-std-medium');
  });
});
