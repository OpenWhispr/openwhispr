import React from 'react';
import { Alert } from 'react-native';
import { render } from '@testing-library/react-native';
import { ProAccessConfirmation } from '../ProAccessConfirmation';

describe('ProAccessConfirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it('shows purchase confirmation once and consumes the route intent', () => {
    const onConsumed = jest.fn();
    const screen = render(<ProAccessConfirmation completion="purchased" onConsumed={onConsumed} />);

    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Welcome to OpenWhispr Pro',
      'Your purchase was successful. Pro features are ready to use.',
      [{ text: 'Start using Pro' }],
    );

    screen.rerender(<ProAccessConfirmation completion="purchased" onConsumed={onConsumed} />);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('uses restoration-specific copy', () => {
    render(<ProAccessConfirmation completion="restored" onConsumed={jest.fn()} />);

    expect(Alert.alert).toHaveBeenCalledWith(
      'OpenWhispr Pro Restored',
      'Your subscription was restored. Pro features are ready to use.',
      [{ text: 'Start using Pro' }],
    );
  });

  it('renders nothing for an absent completion', () => {
    render(<ProAccessConfirmation completion={null} onConsumed={jest.fn()} />);

    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
