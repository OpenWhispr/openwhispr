import { act, render } from '@testing-library/react-native';
import { Text, useColorScheme } from 'react-native';

const mockPrepare = jest.fn(async () => true);
const mockFade = jest.fn();
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: (ms: number) => mockFade(ms),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));

import { THEME_FADE_MS, ThemeProvider, makeStyles, themeFor, useTheme } from '../ThemeProvider';
import { darkTheme, lightTheme, recipes } from '../theme';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;

let renders = 0;
function Probe() {
  const t = useTheme();
  renders += 1;
  return (
    <Text testID="probe">{`${t.scheme} ${t.tokens.canvas} ${String(t.flat.backgroundColor)}`}</Text>
  );
}

const useStyles = makeStyles((t) => ({ page: { backgroundColor: t.tokens.canvas } }));
function Styled() {
  const styles = useStyles();
  return (
    <Text testID="styled" style={styles.page}>
      styled
    </Text>
  );
}

beforeEach(() => {
  mockPrepare.mockClear();
  mockFade.mockClear();
  mockScheme.mockReturnValue('light');
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

it('gives the same keys in both palettes', () => {
  expect(Object.keys(darkTheme).sort()).toEqual(Object.keys(lightTheme).sort());
  expect(darkTheme.canvas).toBe('#0E0F13');
  expect(darkTheme.accent).toBe('#6E9BFF');
  // The brand glass and the blue screens don't change.
  expect(darkTheme.glassTop).toBe(lightTheme.glassTop);
  expect(recipes('dark').glass).toBe(recipes('light').glass);
});

it.each(['light', 'dark'] as const)('renders the %s scheme from the system', (scheme) => {
  mockScheme.mockReturnValue(scheme);
  const view = render(
    <ThemeProvider>
      <Probe />
      <Styled />
    </ThemeProvider>,
  );
  const expected = themeFor(scheme);
  expect(view.getByTestId('probe').props.children).toBe(
    `${scheme} ${expected.tokens.canvas} ${expected.tokens.surface}`,
  );
  expect(view.getByTestId('styled').props.style).toEqual({
    backgroundColor: expected.tokens.canvas,
  });
});

it('is light outside a provider', () => {
  const view = render(<Probe />);
  expect(view.getByTestId('probe').props.children).toContain('light #EFF0F2');
});

it('switches in place under a frozen frame, then fades it out', async () => {
  const view = render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  const probe = view.getByTestId('probe');
  mockScheme.mockReturnValue('dark');
  view.rerender(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  // Still light until the native copy of the frame is up.
  expect(view.getByTestId('probe').props.children).toContain('light');
  await act(async () => {});
  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('probe').props.children).toContain('dark #0E0F13');
  // The same element: re-rendered, not remounted.
  expect(view.getByTestId('probe')).toBe(probe);
  expect(mockFade).not.toHaveBeenCalled();
  act(() => jest.runAllTimers());
  expect(mockFade).toHaveBeenCalledWith(THEME_FADE_MS);
});

it('switches without a fade when the native copy is unavailable', async () => {
  mockPrepare.mockResolvedValueOnce(false);
  const view = render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  mockScheme.mockReturnValue('dark');
  view.rerender(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  await act(async () => {});
  expect(view.getByTestId('probe').props.children).toContain('dark');
  act(() => jest.runAllTimers());
  expect(mockFade).not.toHaveBeenCalled();
});

it('drops a switch the system took back before the copy was ready', async () => {
  let release: (ready: boolean) => void = () => undefined;
  mockPrepare.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)));
  const view = render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  mockScheme.mockReturnValue('dark');
  view.rerender(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  mockScheme.mockReturnValue('light');
  view.rerender(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  await act(async () => release(true));
  expect(view.getByTestId('probe').props.children).toContain('light');
});

it('lets an override win over the system (a later manual setting, K8)', () => {
  renders = 0;
  const view = render(
    <ThemeProvider override="dark">
      <Probe />
    </ThemeProvider>,
  );
  expect(view.getByTestId('probe').props.children).toContain('dark');
  expect(renders).toBe(1);
});
