import {
  CommonActions as mockCommonActions,
  StackActions as mockStackActions,
  StackRouter,
} from '@react-navigation/routers';
import { NativeBottomTabsRouter } from 'expo-router/build/native-tabs/NativeBottomTabsRouter';
import { navigateHome } from '../navigateHome';

// Native tabs only needs the real routers here; avoid loading native UI components.
jest.mock('@react-navigation/native', () => jest.requireActual('@react-navigation/routers'));

const mockDispatch = jest.fn();
let mockTargetRoute = '(record)';
jest.mock('expo-router', () => ({
  router: {
    navigate: (href: string) => {
      expect(href).toBe('/(tabs)/(record)');
      return mockDispatch(
        mockCommonActions.navigate(mockTargetRoute, { screen: 'index', params: {} }),
      );
    },
    replace: (href: string) => {
      expect(href).toBe('/(tabs)/(record)');
      return mockDispatch(
        mockStackActions.replace(mockTargetRoute, { screen: 'index', params: {} }),
      );
    },
  },
}));

beforeEach(() => {
  mockDispatch.mockReset();
  mockTargetRoute = '(record)';
});

it.each(['(chat)', '(notes)', '(dictionary)'])(
  'returns from %s to the native Record tab',
  (tab) => {
    const tabRouter = NativeBottomTabsRouter({ initialRouteName: tab });
    const options = {
      routeNames: ['(record)', '(notes)', '(chat)', '(dictionary)'],
      routeParamList: {},
      routeGetIdList: {},
    };
    const state = tabRouter.getInitialState(options);
    mockDispatch.mockImplementation((action) =>
      tabRouter.getStateForAction(state, action, options),
    );

    navigateHome(true);

    const nextState = mockDispatch.mock.results[0].value;
    expect(nextState).not.toBeNull();
    expect(nextState.routes[nextState.index].name).toBe('(record)');
    expect(nextState.routes).toHaveLength(state.routes.length);
  },
);

it('replaces the current screen when returning from outside the tabs', () => {
  mockTargetRoute = '(tabs)';
  const stackRouter = StackRouter({ initialRouteName: '(account)' });
  const options = {
    routeNames: ['(tabs)', '(account)'],
    routeParamList: {},
    routeGetIdList: {},
  };
  const state = stackRouter.getInitialState(options);
  mockDispatch.mockImplementation((action) =>
    stackRouter.getStateForAction(state, action, options),
  );

  navigateHome(false);

  const nextState = mockDispatch.mock.results[0].value;
  expect(nextState.routes.map((route: { name: string }) => route.name)).toEqual(['(tabs)']);
});
