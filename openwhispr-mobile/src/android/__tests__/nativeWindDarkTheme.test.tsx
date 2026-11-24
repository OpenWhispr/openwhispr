import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, TextInput, type StyleProp, type TextStyle } from 'react-native';
import { ThemeProvider, themeFor } from '../ThemeProvider';
import { SpeakerRenameSheet } from '../../components/notes/SpeakerRenameSheet.android';

jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: async () => false,
  fadeTheme: () => undefined,
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: () => ({ copy: (_key: string, fallback: string) => fallback }),
}));
const colour = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as StyleProp<TextStyle>)?.color;

/** The shared Android parts used to colour through NativeWind classes, fixed light on Android. */
describe('shared Android parts follow the scheme in use', () => {
  const sheet = (scheme: 'light' | 'dark') => (
    <ThemeProvider override={scheme}>
      <SpeakerRenameSheet
        visible
        initialName="Sam"
        suggestions={[{ label: 'Alex Kim' }]}
        onCancel={() => {}}
        onSave={() => {}}
      />
    </ThemeProvider>
  );

  it('draws the speaker-rename chips and title in ink for each scheme', async () => {
    const view = render(sheet('light'));
    const title = () => view.getByText('Rename speaker');
    const chip = () => view.getByText('Alex Kim');
    expect(colour(title())).not.toBe(themeFor('dark').tokens.ink);

    view.rerender(sheet('dark'));
    await view.findByText('Rename speaker');
    expect(colour(title())).toBe(themeFor('dark').tokens.ink);
    expect(colour(chip())).toBe(themeFor('dark').tokens.ink);
  });

  it('keeps a typed name through a live switch', async () => {
    const view = render(sheet('light'));
    const input = view.UNSAFE_getByType(TextInput);
    fireEvent.changeText(input, 'Samantha');
    view.rerender(sheet('dark'));
    await view.findByText('Rename speaker');
    expect(view.UNSAFE_getByType(TextInput).props.value).toBe('Samantha');
    expect(colour(view.UNSAFE_getByType(TextInput))).toBe(themeFor('dark').tokens.ink);
  });
});
