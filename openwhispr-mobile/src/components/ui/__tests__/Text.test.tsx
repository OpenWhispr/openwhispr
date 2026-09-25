import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

// nativewind's native build does not load under Jest; className is unused here.
jest.mock('nativewind', () => ({ cssInterop: <T,>(component: T): T => component }));

const mockFonts: { displayFontFamily: string | undefined } = { displayFontFamily: 'Display' };
jest.mock('@/lib/fonts', () => ({
  get displayFontFamily() {
    return mockFonts.displayFontFamily;
  },
  fontFamilyForWeight: (weight: string | undefined) => `Body-${weight ?? '400'}`,
}));

import { Text } from '../Text';

function fontFamilyOf(element: ReturnType<typeof render>['root']): string | undefined {
  return StyleSheet.flatten(element.props.style).fontFamily;
}

describe('Text', () => {
  beforeEach(() => {
    mockFonts.displayFontFamily = 'Display';
  });

  it('picks the body face for the text weight', () => {
    const { root } = render(<Text style={{ fontWeight: '700' }}>Body</Text>);

    expect(fontFamilyOf(root)).toBe('Body-700');
  });

  it('sets headings in the display face', () => {
    const { root } = render(<Text accessibilityRole="header">Title</Text>);

    expect(fontFamilyOf(root)).toBe('Display');
  });

  it('keeps the weight-based face for headings when there is no display face', () => {
    mockFonts.displayFontFamily = undefined;
    const { root } = render(
      <Text accessibilityRole="header" style={{ fontWeight: '700' }}>
        Title
      </Text>,
    );

    expect(fontFamilyOf(root)).toBe('Body-700');
  });

  it('lets an explicit font family win', () => {
    const { root } = render(
      <Text accessibilityRole="header" style={{ fontFamily: 'Menlo' }}>
        Code
      </Text>,
    );

    expect(fontFamilyOf(root)).toBe('Menlo');
  });
});
