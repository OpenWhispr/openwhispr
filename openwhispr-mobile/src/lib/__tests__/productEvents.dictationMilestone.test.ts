import { recordDictationCompleted } from '../productEvents';
import { recordDictationMilestone } from '../dictationMilestone';

jest.mock('../dictationMilestone', () => ({ recordDictationMilestone: jest.fn() }));

const dictation: Parameters<typeof recordDictationCompleted>[0] = {
  context: { identity: null, isPractice: false, consentSignal: null },
  captureId: 'recording-1',
  words: 12,
  provider: 'local',
  source: 'keyboard',
  retranscribe: false,
};

it('reports every finished dictation to the ad-measurement milestone as well', () => {
  recordDictationCompleted(dictation);

  expect(recordDictationMilestone).toHaveBeenCalledTimes(1);
  expect(recordDictationMilestone).toHaveBeenCalledWith(dictation);
});
