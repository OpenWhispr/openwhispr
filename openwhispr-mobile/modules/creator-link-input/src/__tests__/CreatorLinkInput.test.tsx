import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { View } from 'react-native';
import { CreatorLinkInput } from '..';

jest.mock('expo', () => ({ requireNativeView: () => require('react-native').View }));

it('treats typing, completed paste and keyboard Go as different user actions', () => {
  const onChangeText = jest.fn();
  const onPaste = jest.fn();
  const onSubmit = jest.fn();
  const screen = render(
    <CreatorLinkInput
      value=""
      editable
      onChangeText={onChangeText}
      onPaste={onPaste}
      onSubmit={onSubmit}
      onInvalidPaste={jest.fn()}
    />,
  );
  const input = () => screen.UNSAFE_getByType(View);
  fireEvent(input(), 'input', {
    nativeEvent: { text: 'https://sandbox.dub.link/a', source: 'edit', eventCount: 1 },
  });
  expect(onChangeText).toHaveBeenCalledWith('https://sandbox.dub.link/a');
  expect(onPaste).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent(input(), 'input', {
    nativeEvent: { text: 'https://sandbox.dub.link/complete', source: 'paste', eventCount: 2 },
  });
  expect(onPaste).toHaveBeenCalledWith('https://sandbox.dub.link/complete');
  expect(input().props.mostRecentEventCount).toBe(2);
  fireEvent(input(), 'input', {
    nativeEvent: { text: 'https://sandbox.dub.link/typed', source: 'submit', eventCount: 3 },
  });
  expect(onSubmit).toHaveBeenCalledWith('https://sandbox.dub.link/typed');
});

it('reports oversized paste without submitting old text and ignores disabled callbacks', () => {
  const onPaste = jest.fn();
  const onSubmit = jest.fn();
  const onChangeText = jest.fn();
  const onInvalidPaste = jest.fn();
  const props = { value: 'old', onChangeText, onPaste, onSubmit, onInvalidPaste };
  const screen = render(<CreatorLinkInput {...props} editable />);
  fireEvent(screen.UNSAFE_getByType(View), 'input', {
    nativeEvent: { text: 'old', source: 'tooLong', eventCount: 1 },
  });
  expect(onInvalidPaste).toHaveBeenCalledTimes(1);
  expect(onPaste).not.toHaveBeenCalled();
  screen.rerender(<CreatorLinkInput {...props} editable={false} />);
  for (const source of ['paste', 'edit', 'submit']) {
    fireEvent(screen.UNSAFE_getByType(View), 'input', {
      nativeEvent: { text: 'late', source, eventCount: 2 },
    });
  }
  expect(onPaste).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onChangeText).not.toHaveBeenCalled();
});
