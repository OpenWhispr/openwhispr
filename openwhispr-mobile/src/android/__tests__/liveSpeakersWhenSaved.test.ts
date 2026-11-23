import { forgetLinesSaved, linesSaved, whenLinesSaved } from '@/android/liveSpeakers/whenSaved';

it('runs the waiting work once, when that meeting is saved', () => {
  const work = jest.fn();
  whenLinesSaved(7, work);
  linesSaved(8);
  expect(work).not.toHaveBeenCalled();
  linesSaved(7);
  linesSaved(7);
  expect(work).toHaveBeenCalledTimes(1);
});

it('drops work a failed save leaves behind', () => {
  const work = jest.fn();
  whenLinesSaved(9, work);
  forgetLinesSaved(9);
  linesSaved(9);
  expect(work).not.toHaveBeenCalled();
});
