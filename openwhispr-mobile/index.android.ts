import 'expo-router/entry';
import { AppRegistry } from 'react-native';

// Registered at the top of the bundle: the floating bubble runs this with no app on screen,
// where nothing under app/ is ever evaluated. Loaded lazily so a normal launch is unchanged.
AppRegistry.registerHeadlessTask(
  'OpenWhisprBubblePipeline',
  () => () =>
    (
      require('./src/android/bubblePipeline') as typeof import('./src/android/bubblePipeline')
    ).bubblePipelineTask(),
);
