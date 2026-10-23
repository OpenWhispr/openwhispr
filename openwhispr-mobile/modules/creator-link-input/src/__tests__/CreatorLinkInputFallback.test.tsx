import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { CreatorLinkInput } from '..';

const mockRequireNativeView = jest.fn();
jest.mock('expo', () => ({
  requireNativeView: (name: string) => mockRequireNativeView(name),
  requireOptionalNativeModule: () => null,
}));

it('uses a plain field on a binary built without the native view', () => {
  const onSubmit = jest.fn();
  const onChangeText = jest.fn();
  const screen = render(
    <CreatorLinkInput
      value=""
      editable
      fontFamily="Yowza-Std-Regular"
      onChangeText={onChangeText}
      onPaste={jest.fn()}
      onSubmit={onSubmit}
      onInvalidPaste={jest.fn()}
    />,
  );
  const field = screen.getByLabelText('Creator code or link');
  fireEvent.changeText(field, 'creator');
  fireEvent(field, 'submitEditing', { nativeEvent: { text: 'creator' } });
  expect(onChangeText).toHaveBeenCalledWith('creator');
  expect(onSubmit).toHaveBeenCalledWith('creator');
  expect(mockRequireNativeView).not.toHaveBeenCalled();
});
