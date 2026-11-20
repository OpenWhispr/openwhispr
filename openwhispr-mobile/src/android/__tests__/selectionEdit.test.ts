import {
  buildSelectionEditUserPrompt,
  extractSelectionEditReplacement,
  SelectionEditError,
} from '../selectionEdit';

const reason = (reply: string, selection = 'Send it by Friday.') => {
  try {
    extractSelectionEditReplacement(reply, selection);
    return 'pasted';
  } catch (error) {
    return (error as SelectionEditError).reason;
  }
};

it('sends the selection as a JSON string, then the spoken instruction', () => {
  expect(buildSelectionEditUserPrompt('make it friendlier', 'Say "hi"\nthen go')).toBe(
    'Selected document (JSON string):\n"Say \\"hi\\"\\nthen go"\n\nEditing instruction:\nmake it friendlier\n\nReturn the replacement JSON object.',
  );
});

it('returns the decoded replacement byte for byte', () => {
  expect(
    extractSelectionEditReplacement('{"replacement":"  Could you send it by Friday?\\n"}', 'x'),
  ).toBe('  Could you send it by Friday?\n');
});

it.each([
  ['the bare question marker', '__OPENWHISPR_SELECTION_QUESTION__', 'question'],
  [
    'the marker in the envelope',
    '{"replacement":" __OPENWHISPR_SELECTION_QUESTION__ "}',
    'question',
  ],
  ['a damaged marker', '{"replacement":"__OPENWHISPR_SELECTION_QUESTION and more"}', 'invalid'],
  ['the selection unchanged', '{"replacement":"Send it by Friday. "}', 'unchanged'],
  ['an empty replacement', '{"replacement":"  "}', 'empty'],
  ['an empty reply', '  ', 'empty'],
  ['prose', 'Sure! Here is a friendlier version: Hi!', 'invalid'],
  ['duplicate keys', '{"replacement":"a","replacement":"b"}', 'invalid'],
  ['an extra field', '{"replacement":"a","note":"b"}', 'invalid'],
  ['text after the object', '{"replacement":"a"} Hope this helps!', 'invalid'],
])('refuses %s', (_label, reply, expected) => {
  expect(reason(reply)).toBe(expected);
});

it('takes off one outer ```json fence', () => {
  expect(reason('```json\n{"replacement":"Hi! Could you send it by Friday?"}\n```')).toBe('pasted');
});
