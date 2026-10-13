import type { PlatformOSType } from 'react-native';

const mockGetLoadedFonts = jest.fn<string[], []>();
jest.mock('expo-font', () => ({ getLoadedFonts: () => mockGetLoadedFonts() }));

const IOS_YOWZA_FACES = ['Yowza-Std-Regular', 'Yowza-Soft-Std-Medium'];

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

  it('uses Yowza for regular text and Yowza Soft for headings when embedded', () => {
    const fonts = loadFontsWith(IOS_YOWZA_FACES);

    expect(fonts.fontFamilyForWeight(undefined)).toBe('Yowza-Std-Regular');
    expect(fonts.fontFamilyForWeight('normal')).toBe('Yowza-Std-Regular');
    expect(fonts.displayFontFamily).toBe('Yowza-Soft-Std-Medium');
  });

  // Yowza's own Medium and Bold read too heavy on mobile.
  it.each(['500', '600', '700', 'bold', '900'] as const)(
    'sets %s-weight text in Yowza Soft Medium',
    (weight) => {
      const fonts = loadFontsWith(IOS_YOWZA_FACES);

      expect(fonts.fontFamilyForWeight(weight)).toBe('Yowza-Soft-Std-Medium');
    },
  );

  it('keeps Space Grotesk when only some Yowza faces are embedded', () => {
    const fonts = loadFontsWith(IOS_YOWZA_FACES.slice(0, 1));

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
