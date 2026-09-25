import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

import { KeyboardHandoffReturnView } from '../KeyboardHandoffReturnView';

describe('KeyboardHandoffReturnView', () => {
  it('stays quiet while returning: no button, no instructions', () => {
    render(
      <KeyboardHandoffReturnView
        mode="returning"
        hostName={null}
        onCancel={jest.fn()}
        onBackToHost={jest.fn()}
      />,
    );
    expect(screen.getByText('Returning to your app…')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeOnTheScreen();
    expect(screen.queryByText(/Swipe/)).not.toBeOnTheScreen();
  });

  it('offers one button back to the named host', () => {
    const onBackToHost = jest.fn();
    render(
      <KeyboardHandoffReturnView
        mode="back_to_host"
        hostName="Slack"
        onCancel={jest.fn()}
        onBackToHost={onBackToHost}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Back to Slack' }));
    expect(onBackToHost).toHaveBeenCalledTimes(1);
  });

  it('keeps the cancel control on both screens', () => {
    const onCancel = jest.fn();
    render(
      <KeyboardHandoffReturnView
        mode="returning"
        hostName={null}
        onCancel={onCancel}
        onBackToHost={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByLabelText('Cancel and discard'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
