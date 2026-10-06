import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

let mockLanguages: string[] = ['fr'];

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => {
    const { Pressable } = require('react-native');
    return <Pressable accessibilityLabel={accessibilityLabel} onPress={onPress} />;
  },
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => mockLanguages,
}));

import { ModelLanguagesButton } from '../ModelLanguagesButton';

beforeEach(() => {
  mockLanguages = ['fr'];
});

function openSheet(label: string): void {
  fireEvent.press(screen.getByLabelText(label));
}

it('opens the model language list from the question mark', () => {
  render(<ModelLanguagesButton model="parakeet-v3" />);
  expect(screen.queryByText('Parakeet v3 Languages')).toBeNull();
  openSheet('Parakeet v3 languages');
  expect(screen.getByText('Parakeet v3 Languages')).toBeTruthy();
  expect(screen.getByText('German')).toBeTruthy();
  expect(screen.getByText('All 26 Languages')).toBeTruthy();
});

it('puts the chosen language first and says whether the model supports it', () => {
  mockLanguages = ['fr', 'he'];
  render(<ModelLanguagesButton model="parakeet-v3" />);
  openSheet('Parakeet v3 languages');
  const page = JSON.stringify(screen.toJSON());
  expect(page.indexOf('Your Languages')).toBeLessThan(page.indexOf('All 26 Languages'));
  expect(screen.getByLabelText('French, supported')).toBeTruthy();
  expect(screen.getByLabelText('Hebrew, not supported')).toBeTruthy();
});

it('has no chosen-language section for Auto-detect', () => {
  mockLanguages = [];
  render(<ModelLanguagesButton model="parakeet-v3" />);
  openSheet('Parakeet v3 languages');
  expect(screen.queryByText('Your Language')).toBeNull();
  expect(screen.queryByText('Your Languages')).toBeNull();
});

it('searches the long Whisper list and notes its auto-detect', () => {
  render(<ModelLanguagesButton model="whisper-base" />);
  openSheet('Whisper base languages');
  expect(screen.getByText(/also detects the spoken language/)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search languages'), 'heb');
  expect(screen.getByText('Hebrew')).toBeTruthy();
  expect(screen.queryByText('German')).toBeNull();
});

it('has no search on a short list', () => {
  render(<ModelLanguagesButton model="parakeet-v3" />);
  openSheet('Parakeet v3 languages');
  expect(screen.queryByLabelText('Search languages')).toBeNull();
});

it('closes the sheet', () => {
  render(<ModelLanguagesButton model="parakeet-v3" />);
  openSheet('Parakeet v3 languages');
  fireEvent.press(screen.getByLabelText('Close'));
  expect(screen.queryByText('Parakeet v3 Languages')).toBeNull();
});
