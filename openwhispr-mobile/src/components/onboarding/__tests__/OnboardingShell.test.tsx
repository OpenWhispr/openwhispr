import type React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Sentry } from '@/lib/sentry';
import { OnboardingError } from '@/lib/onboardingErrors';
import { OnboardingShell } from '../OnboardingShell';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/Button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: ({
      children,
      onPress,
      disabled,
      loading,
    }: {
      children: React.ReactNode;
      onPress: () => void;
      disabled?: boolean;
      loading?: boolean;
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: Boolean(loading), disabled: Boolean(disabled || loading) }}
        onPress={onPress}
        disabled={disabled || loading}
      >
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});

beforeEach(() => jest.clearAllMocks());

// Tapping "Use Local" used to spin the "Use Cloud" button, which read as Cloud being chosen.
it.each(['card', 'link'] as const)('marks only the pressed %s control as busy', async (variant) => {
  let release!: () => void;
  render(
    <OnboardingShell
      title="How should we transcribe?"
      ctaLabel="Use Cloud"
      onCta={jest.fn()}
      secondaryCtaLabel="Use Local"
      secondaryCtaVariant={variant}
      onSecondaryCta={() => new Promise<void>((resolve) => (release = resolve))}
    />,
  );

  fireEvent.press(screen.getByText('Use Local'));

  expect(screen.getByRole('button', { name: 'Use Local' })).toBeBusy();
  expect(screen.getByRole('button', { name: 'Use Cloud' })).not.toBeBusy();
  expect(screen.getByRole('button', { name: 'Use Cloud' })).toBeDisabled();
  await act(async () => release());
});

it('reports an unexpected failure and shows the fallback instead of its text', async () => {
  const error = new Error("Calling the 'setValueWithKeyAsync' function has failed");
  render(<OnboardingShell title="Tone" ctaLabel="Continue" onCta={() => Promise.reject(error)} />);

  fireEvent.press(screen.getByText('Continue'));

  expect(await screen.findByText('Could not save your progress. Try again.')).toBeTruthy();
  expect(screen.queryByText(/setValueWithKeyAsync/)).toBeNull();
  expect(Sentry.captureException).toHaveBeenCalledWith(error);
});

it('shows a failure written for the user as is', async () => {
  const message = 'Cloud needs a connection to set up. Try again or use Local for now.';
  render(
    <OnboardingShell
      title="Mode"
      ctaLabel="Use Cloud"
      onCta={() => Promise.reject(new OnboardingError(message))}
    />,
  );

  fireEvent.press(screen.getByText('Use Cloud'));

  expect(await screen.findByText(message)).toBeTruthy();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it('retries the action that failed, not the primary one', async () => {
  const onCta = jest.fn();
  const onSecondaryCta = jest
    .fn()
    .mockRejectedValueOnce(new Error('Keychain unavailable'))
    .mockResolvedValueOnce(undefined);
  render(
    <OnboardingShell
      title="Mode"
      ctaLabel="Use Cloud"
      onCta={onCta}
      secondaryCtaLabel="Use Local"
      onSecondaryCta={onSecondaryCta}
    />,
  );

  fireEvent.press(screen.getByText('Use Local'));
  fireEvent.press(await screen.findByText('Retry'));

  await act(async () => undefined);
  expect(onSecondaryCta).toHaveBeenCalledTimes(2);
  expect(onCta).not.toHaveBeenCalled();
});

it('shows Back as an arrow that screen readers still call Back', async () => {
  const onBack = jest.fn();
  render(<OnboardingShell title="Tone" ctaLabel="Continue" onCta={jest.fn()} onBack={onBack} />);

  expect(screen.queryByText('Back')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Back' }));

  await act(async () => undefined);
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('offers a help button only on steps that provide help', () => {
  const onHelp = jest.fn();
  const { rerender } = render(
    <OnboardingShell title="Switch" ctaLabel="I switched" onCta={jest.fn()} />,
  );
  expect(screen.queryByRole('button', { name: 'Help' })).toBeNull();

  rerender(
    <OnboardingShell title="Switch" ctaLabel="I switched" onCta={jest.fn()} onHelp={onHelp} />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Help' }));

  expect(onHelp).toHaveBeenCalledTimes(1);
});
