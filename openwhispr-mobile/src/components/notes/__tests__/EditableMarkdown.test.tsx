import { fireEvent, render } from '@testing-library/react-native';
import { EditableMarkdown } from '../EditableMarkdown';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => {
    const { Text } = require('react-native');
    return <Text testID="rendered-markdown">{content}</Text>;
  },
}));

describe('EditableMarkdown', () => {
  it('renders the Markdown and switches to the raw source on Edit', () => {
    const onEditingChange = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <EditableMarkdown
        content="## Summary"
        onChange={jest.fn()}
        onEditingChange={onEditingChange}
      />,
    );
    expect(getByTestId('rendered-markdown').props.children).toBe('## Summary');
    expect(queryByTestId('enhanced-editor')).toBeNull();

    fireEvent.press(getByTestId('enhanced-edit'));

    expect(getByTestId('enhanced-editor').props.value).toBe('## Summary');
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
  });

  it('enters editing when the rendered notes are tapped', () => {
    const { getByTestId } = render(<EditableMarkdown content="## Summary" onChange={jest.fn()} />);
    fireEvent.press(getByTestId('enhanced-read'));
    expect(getByTestId('enhanced-editor')).toBeTruthy();
  });

  it('does not enter editing on a long press, so text can be selected', () => {
    const { getByTestId, queryByTestId } = render(
      <EditableMarkdown content="## Summary" onChange={jest.fn()} />,
    );
    fireEvent(getByTestId('enhanced-read'), 'longPress');
    expect(queryByTestId('enhanced-editor')).toBeNull();
  });

  it('reports each change and shows the edited notes after Done', () => {
    const onChange = jest.fn();
    const onEditingChange = jest.fn();
    const { getByTestId } = render(
      <EditableMarkdown
        content="## Summary"
        onChange={onChange}
        onEditingChange={onEditingChange}
      />,
    );
    fireEvent.press(getByTestId('enhanced-edit'));
    expect(getByTestId('enhanced-editor').props.accessibilityLabel).toBe('Enhanced notes');
    fireEvent.changeText(getByTestId('enhanced-editor'), '## Summary\n- Launch Friday');
    expect(onChange).toHaveBeenCalledWith('## Summary\n- Launch Friday');

    fireEvent.press(getByTestId('enhanced-done'));

    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    expect(getByTestId('rendered-markdown').props.children).toBe('## Summary\n- Launch Friday');
  });

  it('cannot be edited while editable is false', () => {
    const { getByTestId, queryByTestId } = render(
      <EditableMarkdown content="## Summary" editable={false} onChange={jest.fn()} />,
    );
    expect(queryByTestId('enhanced-edit')).toBeNull();
    fireEvent.press(getByTestId('enhanced-read'));
    expect(queryByTestId('enhanced-editor')).toBeNull();
  });

  it('leaves editing when it stops being editable', () => {
    const onEditingChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <EditableMarkdown
        content="## Summary"
        onChange={jest.fn()}
        onEditingChange={onEditingChange}
      />,
    );
    fireEvent.press(getByTestId('enhanced-edit'));
    rerender(
      <EditableMarkdown
        content="## Summary"
        editable={false}
        onChange={jest.fn()}
        onEditingChange={onEditingChange}
      />,
    );
    expect(queryByTestId('enhanced-editor')).toBeNull();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('shows new saved notes while reading', () => {
    const { getByTestId, rerender } = render(
      <EditableMarkdown content="## Old" onChange={jest.fn()} />,
    );
    rerender(<EditableMarkdown content="## New" onChange={jest.fn()} />);
    expect(getByTestId('rendered-markdown').props.children).toBe('## New');
  });

  it('follows new saved notes while an open edit is untouched', () => {
    const { getByTestId, rerender } = render(
      <EditableMarkdown content="## Old" onChange={jest.fn()} />,
    );
    fireEvent.press(getByTestId('enhanced-edit'));
    rerender(<EditableMarkdown content="## New" onChange={jest.fn()} />);
    expect(getByTestId('enhanced-editor').props.value).toBe('## New');

    fireEvent.press(getByTestId('enhanced-done'));

    expect(getByTestId('rendered-markdown').props.children).toBe('## New');
  });

  it('keeps what the user typed when new saved notes arrive mid-edit', () => {
    const { getByTestId, rerender } = render(
      <EditableMarkdown content="## Old" onChange={jest.fn()} />,
    );
    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '## Mine');
    rerender(<EditableMarkdown content="## New" onChange={jest.fn()} />);
    expect(getByTestId('enhanced-editor').props.value).toBe('## Mine');
  });

  it('follows saved notes again once a new edit starts', () => {
    const { getByTestId, rerender } = render(
      <EditableMarkdown content="## Old" onChange={jest.fn()} />,
    );
    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '## Mine');
    fireEvent.press(getByTestId('enhanced-done'));
    rerender(<EditableMarkdown content="## Mine" onChange={jest.fn()} />);

    fireEvent.press(getByTestId('enhanced-edit'));
    rerender(<EditableMarkdown content="## New" onChange={jest.fn()} />);

    expect(getByTestId('enhanced-editor').props.value).toBe('## New');
  });

  it('leaves the rendered notes to screen readers instead of reading them as one block', () => {
    const { getByTestId } = render(<EditableMarkdown content="## Summary" onChange={jest.fn()} />);
    expect(getByTestId('enhanced-read').props.accessible).toBe(false);
  });

  it('reports leaving editing when unmounted mid-edit', () => {
    const onEditingChange = jest.fn();
    const { getByTestId, unmount } = render(
      <EditableMarkdown
        content="## Summary"
        onChange={jest.fn()}
        onEditingChange={onEditingChange}
      />,
    );
    fireEvent.press(getByTestId('enhanced-edit'));
    unmount();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });
});
