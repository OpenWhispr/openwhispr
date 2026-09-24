import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

// nativewind's cssInterop breaks jest's transform; same stub the other screen suites use.
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/services/transcription/LocalParakeetService', () => ({
  LocalParakeetService: {
    modelNotices: jest.fn(async () => []),
  },
}));

import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import LicensesScreen from '../LicensesScreen';

const mockParakeet = LocalParakeetService as jest.Mocked<typeof LocalParakeetService>;

beforeEach(() => {
  jest.clearAllMocks();
  mockParakeet.modelNotices.mockResolvedValue([]);
});

describe('LicensesScreen', () => {
  it('credits Orukeet, the Oruk FluidAudio fork and the libraries it brings in', async () => {
    render(<LicensesScreen />);

    expect(await screen.findByText('Orukeet r3')).toBeTruthy();
    expect(screen.getByText('CC-BY-SA-4.0')).toBeTruthy();
    expect(screen.getByText(/Oruk AI's fork/)).toBeTruthy();
    expect(screen.getByText('ZIPFoundation')).toBeTruthy();
    expect(screen.getByText('OrukeetCoreML')).toBeTruthy();
  });

  it('shows the notices shipped with an installed Orukeet model on request', async () => {
    mockParakeet.modelNotices.mockResolvedValue([
      { fileName: 'NOTICE.md', text: 'Orukeet is an adaptation of NVIDIA Parakeet.' },
      { fileName: 'COREML-NOTICE.txt', text: 'Core ML conversion notice.' },
    ]);
    render(<LicensesScreen />);

    fireEvent.press(await screen.findByText('View model notices'));

    expect(mockParakeet.modelNotices).toHaveBeenCalledWith('orukeet');
    expect(screen.getByText('NOTICE.md')).toBeTruthy();
    expect(screen.getByText('Orukeet is an adaptation of NVIDIA Parakeet.')).toBeTruthy();
    expect(screen.getByText('Core ML conversion notice.')).toBeTruthy();
  });

  it('offers no notices while Orukeet is not installed', async () => {
    render(<LicensesScreen />);

    await screen.findByText('Orukeet r3');
    expect(screen.queryByText('View model notices')).toBeNull();
  });
});
