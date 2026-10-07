import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { render } from '@testing-library/react-native';
import { Toast } from '../Toast';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('expo-image', () => ({ Image: () => null }));

it('announces a repeated identical result each time it is shown', () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { rerender } = render(<Toast message="Connection works." visible showId={1} />);
  rerender(<Toast message="Connection works." visible showId={2} />);
  expect(announce).toHaveBeenCalledTimes(2);
});
