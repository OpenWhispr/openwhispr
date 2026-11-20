import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useConfigStore } from '@/store/useConfigStore';
import StyleScreen from '../StyleScreen';
import ToneSetupScreen from '../style/ToneSetupScreen';
import { ToneStyleNudge } from '../style/ToneStyleNudge';
import { exampleResult, parseExample } from '../style/examples';
import { normalizeToneStyles, readToneStyle, toneKindForApp } from '../style/toneStyle';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockToast = jest.fn();
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: () => mockBack(),
    canGoBack: () => true,
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@react-navigation/native', () => ({ useScrollToTop: () => undefined }));
jest.mock('react-native-svg', () => ({ SvgXml: require('react-native').View }));
jest.mock('expo-image', () => ({ Image: require('react-native').View }));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
jest.mock('@/android/settings/kit', () => {
  const { Pressable } = require('react-native');
  return {
    showToast: (...args: unknown[]) => mockToast(...args),
    Toggle: ({ value, onValueChange, label, disabled }: any) =>
      require('react').createElement(Pressable, {
        accessibilityRole: 'switch',
        accessibilityLabel: label,
        accessibilityState: { checked: value, disabled },
        disabled,
        onPress: () => onValueChange(!value),
      }),
  };
});
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));

const saved = () => readToneStyle(useConfigStore.getState().config);
const setStyle = (androidToneStyle?: object) =>
  useConfigStore.setState({
    config: { defaultMode: 'cloud', androidToneStyle } as never,
    error: null,
    updateConfig: jest.fn(async (change: object) => {
      useConfigStore.setState((state) => ({
        config: { ...state.config!, ...change },
        error: null,
      }));
    }),
  } as never);

beforeEach(() => {
  jest.clearAllMocks();
  setStyle();
});

describe('kind of app', () => {
  it.each([
    ['com.whatsapp', 'personal'],
    ['org.telegram.messenger', 'personal'],
    ['com.google.android.apps.messaging', 'personal'],
    ['com.Slack', 'work'],
    ['com.microsoft.teams', 'work'],
    ['com.google.android.apps.dynamite', 'work'],
    ['com.google.android.gm', 'email'],
    ['com.microsoft.office.outlook', 'email'],
    ['ch.protonmail.android', 'email'],
    ['com.example.mail', 'email'],
    ['com.android.chrome', 'other'],
    ['notion.id', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ])('%s is %s', (app, kind) => {
    expect(toneKindForApp(app)).toBe(kind);
  });

  it('keeps only tones offered for each kind', () => {
    expect(normalizeToneStyles({ personal: 'excited', work: 'casual', email: 'nope' })).toEqual({
      personal: 'casual',
      work: 'casual',
      email: 'formal',
      other: 'formal',
    });
  });
});

describe('examples', () => {
  it('marks dropped and added words', () => {
    expect(parseExample('~um~ +Hey+ there+?+')).toEqual([
      { text: 'um', change: 'drop' },
      { text: ' ' },
      { text: 'Hey', change: 'add' },
      { text: ' there' },
      { text: '?', change: 'add' },
    ]);
    expect(exampleResult('~um~ +Hey+ there+?+ ~like~ you')).toBe('Hey there? you');
  });
});

describe('Style tab', () => {
  it('runs the setup on the first switch-on instead of turning it on', () => {
    render(<StyleScreen />);
    fireEvent.press(screen.getByRole('switch', { name: 'switchLabel' }));
    expect(mockPush).toHaveBeenCalledWith('/android-tone-setup');
    expect(saved().enabled).toBe(false);
  });

  it('turns off and on again once set up, without a toast', async () => {
    setStyle({ enabled: true, setUp: true });
    render(<StyleScreen />);
    await act(async () => {
      fireEvent.press(screen.getByRole('switch', { name: 'switchLabel' }));
    });
    expect(saved().enabled).toBe(false);
    expect(screen.getByText('subtitleOff')).toBeTruthy();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('saves a tone for the kind on screen at once, with the toast', async () => {
    setStyle({ enabled: true, setUp: true });
    render(<StyleScreen />);
    fireEvent.press(screen.getByRole('tab', { name: 'rowEmail' }));
    const slider = screen.getByRole('adjustable');
    await act(async () => {
      fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    });
    expect(saved().tones).toEqual({
      personal: 'casual',
      work: 'formal',
      email: 'casual',
      other: 'formal',
    });
    expect(mockToast).toHaveBeenCalledWith('saved', 'success', undefined, { aboveTabBar: true });
  });

  it('reports a save the store refused', async () => {
    setStyle({ enabled: true, setUp: true });
    useConfigStore.setState({
      updateConfig: jest.fn(async () => useConfigStore.setState({ error: 'disk full' })),
    } as never);
    render(<StyleScreen />);
    await act(async () => {
      fireEvent(screen.getByRole('adjustable'), 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
    });
    expect(mockToast).toHaveBeenCalledWith('saveFailed', 'error', undefined, { aboveTabBar: true });
  });
});

describe('setup', () => {
  it('walks the four kinds and turns Tone & Style on at Done', async () => {
    render(<ToneSetupScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'letsPersonalize' }));
    // Personal: pick Very casual from the deck.
    fireEvent.press(screen.getByRole('radio', { name: 'toneVeryCasual. describeVeryCasual' }));
    fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    for (let i = 0; i < 3; i += 1)
      fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    expect(screen.getByText('doneTitle')).toBeTruthy();
    // A summary row opens its step and comes back.
    fireEvent.press(screen.getByRole('button', { name: 'rowWork, toneFormal' }));
    fireEvent.press(screen.getByRole('radio', { name: 'toneExcited. describeExcited' }));
    fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    expect(saved().enabled).toBe(false);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'done' }));
    });
    expect(saved()).toEqual({
      enabled: true,
      setUp: true,
      nudgeDismissed: false,
      tones: { personal: 'very_casual', work: 'excited', email: 'formal', other: 'formal' },
    });
    expect(mockBack).toHaveBeenCalled();
  });

  it('closes without saving', () => {
    render(<ToneSetupScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'letsPersonalize' }));
    fireEvent.press(screen.getByRole('button', { name: 'close' }));
    expect(mockBack).toHaveBeenCalled();
    expect(saved().setUp).toBe(false);
  });
});

describe('Home card', () => {
  it('waits for 70 dictated words', () => {
    render(<ToneStyleNudge words={69} />);
    expect(screen.queryByText('nudgeTitle')).toBeNull();
  });

  it('opens the setup or goes away for good', async () => {
    render(<ToneStyleNudge words={70} />);
    fireEvent.press(screen.getByRole('button', { name: 'startNow' }));
    expect(mockPush).toHaveBeenCalledWith('/android-tone-setup');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'notNow' }));
    });
    expect(saved().nudgeDismissed).toBe(true);
    expect(screen.queryByText('nudgeTitle')).toBeNull();
  });

  it('stays away once set up', () => {
    setStyle({ setUp: true });
    render(<ToneStyleNudge words={500} />);
    expect(screen.queryByText('nudgeTitle')).toBeNull();
  });
});
