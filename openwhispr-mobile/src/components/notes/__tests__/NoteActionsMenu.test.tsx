import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { NoteActionsMenu } from '../NoteActionsMenu';

jest.mock('@react-native-menu/menu', () => ({
  MenuView: ({
    actions,
    onPressAction,
    children,
  }: {
    actions: { id: string; title: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: React.ReactNode;
  }) => {
    const { Pressable, Text, View } = require('react-native');
    return (
      <View>
        {children}
        {actions.map((action) => (
          <Pressable
            key={action.id}
            testID={`menu-${action.id}`}
            accessibilityState={{ disabled: !!action.attributes?.disabled }}
            onPress={() => onPressAction({ nativeEvent: { event: action.id } })}
          >
            <Text>{action.title}</Text>
          </Pressable>
        ))}
      </View>
    );
  },
}));
jest.mock('@sentry/react-native', () => ({ captureException: jest.fn() }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassCapsule: ({ children }: { children?: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));
jest.mock('@/store/useNotesStore', () => {
  const state = { notes: [], setNotePrivacy: jest.fn() };
  return {
    useNotesStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const baseProps = {
  noteId: 7,
  actions: [],
  hasContent: true,
  isRecording: false,
  processing: false,
  onRunAction: jest.fn(),
  onManageActions: jest.fn(),
  onShare: jest.fn(),
  onDelete: jest.fn(),
};

describe('NoteActionsMenu', () => {
  it('opens the transcript from View Transcript', () => {
    const onViewTranscript = jest.fn();
    const { getByTestId, getByText } = render(
      <NoteActionsMenu {...baseProps} onViewTranscript={onViewTranscript} />,
    );
    expect(getByText('View Transcript')).toBeTruthy();
    fireEvent.press(getByTestId('menu-__view_transcript'));
    expect(onViewTranscript).toHaveBeenCalled();
  });

  it('lets the caller decide when Ask is available, even without note body content', () => {
    const { getByTestId, rerender } = render(
      <NoteActionsMenu {...baseProps} hasContent={false} onAskNote={jest.fn()} />,
    );
    expect(getByTestId('menu-__ask_note').props.accessibilityState.disabled).toBe(false);

    rerender(
      <NoteActionsMenu {...baseProps} hasContent={false} onAskNote={jest.fn()} askNoteDisabled />,
    );
    expect(getByTestId('menu-__ask_note').props.accessibilityState.disabled).toBe(true);
  });

  it('has no transcript item for a note without a transcript', () => {
    const { queryByText } = render(<NoteActionsMenu {...baseProps} />);
    expect(queryByText('View Transcript')).toBeNull();
    expect(queryByText('Copy Transcript')).toBeNull();
  });
});

it('ignores stale native menu events while recording is processing', () => {
  const onDelete = jest.fn();
  const onManageActions = jest.fn();
  const { getByTestId } = render(
    <NoteActionsMenu
      {...baseProps}
      processing
      onDelete={onDelete}
      onManageActions={onManageActions}
    />,
  );
  fireEvent.press(getByTestId('menu-__delete'));
  fireEvent.press(getByTestId('menu-__manage'));
  expect(onDelete).not.toHaveBeenCalled();
  expect(onManageActions).not.toHaveBeenCalled();
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: 'ar' },
    t: (key: string, options: { defaultValue: string }) => {
      const resource = require('@/locales/ar/translation.json').android;
      return (
        key.split('.').reduce((value: any, part: string) => value?.[part], resource) ??
        options.defaultValue
      );
    },
  }),
}));

it('translates Android menu controls while preserving custom action identity and destructive routing', () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    const action = { id: 42, name: 'My literal action' } as any;
    const run = jest.fn();
    const remove = jest.fn();
    const view = render(
      <NoteActionsMenu {...baseProps} actions={[action]} onRunAction={run} onDelete={remove} />,
    );
    expect(view.getByText('إدارة الإجراءات…')).toBeTruthy();
    expect(view.getByLabelText('إجراءات الملاحظة')).toBeTruthy();
    fireEvent.press(view.getByText('My literal action'));
    expect(run).toHaveBeenCalledWith(action);
    expect(remove).not.toHaveBeenCalled();
    fireEvent.press(view.getByText('حذف'));
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    Platform.OS = original;
  }
});
