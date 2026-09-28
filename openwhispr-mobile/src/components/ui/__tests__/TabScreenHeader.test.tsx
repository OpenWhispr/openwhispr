import { StyleSheet, Text as RNText, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { TabScreenHeader } from '../TabScreenHeader';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 0, left: 0 }),
}));

const LONG_TITLE = 'Supabase Migration and OpenTable Integration';

describe('TabScreenHeader', () => {
  it('renders the title alongside the supplied controls', () => {
    const { getByText } = render(
      <TabScreenHeader
        title={LONG_TITLE}
        left={<View testID="left-control" />}
        right={<View testID="right-control" />}
      />,
    );

    expect(getByText(LONG_TITLE)).toBeTruthy();
  });

  // Regression guard: the title is absolutely positioned and centred across the
  // whole row, so without gutters a long one renders underneath the back and
  // options buttons instead of truncating.
  it('insets the centred title so it cannot run under the header buttons', () => {
    const { getByTestId } = render(
      <TabScreenHeader
        title={LONG_TITLE}
        left={<View testID="left-control" />}
        right={<View testID="right-control" />}
      />,
    );

    const style = StyleSheet.flatten(getByTestId('screen-header-title').props.style);

    expect(style.position).toBe('absolute');
    // Buttons are 36pt glass capsules; the gutter must clear them on both sides.
    expect(style.left).toBeGreaterThanOrEqual(36);
    expect(style.right).toBeGreaterThanOrEqual(36);
    // Equal gutters keep the title optically centred whether or not `right` is set.
    expect(style.left).toBe(style.right);
  });

  it('truncates rather than wrapping, so the row keeps its height', () => {
    const { UNSAFE_getAllByType } = render(<TabScreenHeader title={LONG_TITLE} />);
    const titleText = UNSAFE_getAllByType(RNText).find(
      (node) => node.props.children === LONG_TITLE,
    );

    expect(titleText?.props.numberOfLines).toBe(1);
  });
});
