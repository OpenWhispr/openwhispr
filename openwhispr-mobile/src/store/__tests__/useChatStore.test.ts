import { chatMessages } from '@/db/schema';
import type { LocalChatRepository } from '@/data/local/chatRepository';
import { createMemoryChatRepository, type TestDb } from '@/data/local/__tests__/testDb';
import type { ChatTurnInput, ChatTurnResult } from '@/lib/chat/runChatTurn';

let mockRepo: LocalChatRepository;
jest.mock('@/data', () => ({
  get chatRepository() {
    return mockRepo;
  },
}));
jest.mock('@/lib/chat/runChatTurn', () => ({ runChatTurn: jest.fn() }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

import { runChatTurn } from '@/lib/chat/runChatTurn';
import { clearChatHistory } from '@/lib/chat/chatHistory';
import { useChatStore } from '@/store/useChatStore';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const answer = (text: string): ChatTurnResult => ({
  text,
  steps: [{ id: 'write', status: 'done', label: 'Wrote your answer' }],
  sources: [{ noteId: 3, title: 'Pricing call' }],
});

const abortError = (): Error => {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
};

const mockRun = jest.mocked(runChatTurn);
const turnInput = (call: number): ChatTurnInput => mockRun.mock.calls[call][0];
const sendOptions = { allowCloudFallback: false };

let db: TestDb;

beforeEach(() => {
  ({ repo: mockRepo, db } = createMemoryChatRepository());
  mockRun.mockReset();
  useChatStore.getState().reset();
});

describe('useChatStore', () => {
  it('creates a conversation titled from the first question', async () => {
    mockRun.mockResolvedValueOnce(answer('ok'));
    const question = `  ${'x'.repeat(30)}\n\n ${'y'.repeat(39)}  `;

    const sent = useChatStore.getState().send(question, { conversationId: null, ...sendOptions });
    await sent?.done;

    const conversation = mockRepo.getConversation(sent?.conversationId ?? '');
    expect(conversation?.title).toHaveLength(61);
    expect(conversation?.title).toBe(`${'x'.repeat(30)} ${'y'.repeat(29)}…`);
    expect(useChatStore.getState().conversations.map(({ id }) => id)).toEqual([conversation?.id]);
  });

  it('keeps a short question as the whole title', async () => {
    mockRun.mockResolvedValueOnce(answer('ok'));

    const sent = useChatStore.getState().send('  What did   we decide? ', {
      conversationId: null,
      ...sendOptions,
    });
    await sent?.done;

    expect(mockRepo.getConversation(sent?.conversationId ?? '')?.title).toBe('What did we decide?');
  });

  it('cuts a title by character so an emoji is never split', async () => {
    mockRun.mockResolvedValueOnce(answer('ok'));

    const sent = useChatStore.getState().send(`${'x'.repeat(59)}😀😀`, {
      conversationId: null,
      ...sendOptions,
    });
    await sent?.done;

    expect(mockRepo.getConversation(sent?.conversationId ?? '')?.title).toBe(
      `${'x'.repeat(59)}😀…`,
    );
  });

  it('refuses a blank question', () => {
    expect(
      useChatStore.getState().send('   ', { conversationId: null, ...sendOptions }),
    ).toBeNull();
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRepo.listConversations()).toEqual([]);
  });

  it('refuses a send to a deleted chat, or while busy, without saying it failed', () => {
    mockRun.mockReturnValueOnce(deferred<ChatTurnResult>().promise);

    expect(
      useChatStore.getState().send('lost', { conversationId: 'deleted', ...sendOptions }),
    ).toBeNull();
    useChatStore.getState().send('first', { conversationId: null, ...sendOptions });
    expect(
      useChatStore.getState().send('second', { conversationId: null, ...sendOptions }),
    ).toBeNull();
    expect(useChatStore.getState().sendBlocked).toBe(false);
  });

  it('refuses a question it cannot save, says so, and leaves no empty chat', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(mockRepo, 'appendMessage').mockImplementationOnce(() => {
      throw new Error('database or disk is full');
    });

    expect(
      useChatStore.getState().send('Pricing?', { conversationId: null, ...sendOptions }),
    ).toBeNull();
    expect(useChatStore.getState().sendBlocked).toBe(true);
    expect(mockRepo.listConversations()).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses a second send while one is pending', () => {
    mockRun.mockReturnValueOnce(deferred<ChatTurnResult>().promise);
    const other = mockRepo.createConversation('Other');

    const first = useChatStore.getState().send('first', { conversationId: null, ...sendOptions });
    const second = useChatStore.getState().send('second', {
      conversationId: other.id,
      ...sendOptions,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRepo.getMessages(other.id)).toEqual([]);
    expect(useChatStore.getState().pending).toMatchObject({
      conversationId: first?.conversationId,
      phase: 'working',
    });
  });

  it('passes earlier messages as history and records steps while the turn is current', async () => {
    const conversation = mockRepo.createConversation('Pricing');
    const earlier = [
      mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'q1' }),
      mockRepo.appendMessage({ conversationId: conversation.id, role: 'assistant', text: 'a1' }),
    ];
    const turn = deferred<ChatTurnResult>();
    mockRun.mockReturnValueOnce(turn.promise);
    useChatStore.getState().openConversation(conversation.id);

    const sent = useChatStore.getState().send('q2', {
      conversationId: conversation.id,
      allowCloudFallback: true,
    });
    const input = turnInput(0);
    input.onSteps([{ id: 'search', status: 'active', label: 'Searching your notes…' }]);

    expect(input.question).toBe('q2');
    expect(input.history).toEqual(earlier);
    expect(input.allowCloudFallback).toBe(true);
    expect(useChatStore.getState().messages.map(({ text }) => text)).toEqual(['q1', 'a1', 'q2']);
    expect(useChatStore.getState().pending?.steps).toEqual([
      { id: 'search', status: 'active', label: 'Searching your notes…' },
    ]);

    turn.resolve(answer('a2'));
    await sent?.done;

    const last = useChatStore.getState().messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', text: 'a2', sources: answer('a2').sources });
    expect(useChatStore.getState().pending).toBeNull();
    expect(useChatStore.getState().conversations[0].preview).toBe('a2');
  });

  it('saves the answer into the conversation that asked', async () => {
    const other = mockRepo.createConversation('B');
    const turn = deferred<ChatTurnResult>();
    mockRun.mockReturnValueOnce(turn.promise);

    const sent = useChatStore.getState().send('in A', { conversationId: null, ...sendOptions });
    useChatStore.getState().openConversation(other.id);
    turn.resolve(answer('answer for A'));
    await sent?.done;

    const askedIn = mockRepo.getMessages(sent?.conversationId ?? '');
    expect(askedIn.at(-1)).toMatchObject({ role: 'assistant', text: 'answer for A' });
    expect(useChatStore.getState().activeConversationId).toBe(other.id);
    expect(useChatStore.getState().messages.map(({ text }) => text)).not.toContain('answer for A');
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      id: sent?.conversationId,
      preview: 'answer for A',
    });
  });

  it('drops a late answer after reset', async () => {
    const turn = deferred<ChatTurnResult>();
    mockRun.mockReturnValueOnce(turn.promise);

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    const input = turnInput(0);
    clearChatHistory();
    input.onSteps([{ id: 'write', status: 'active', label: 'Writing your answer…' }]);
    turn.resolve(answer('too late'));
    await sent?.done;

    expect(input.signal.aborted).toBe(true);
    expect(mockRepo.listConversations()).toEqual([]);
    expect(db.select().from(chatMessages).all()).toEqual([]);
    expect(useChatStore.getState()).toMatchObject({
      conversations: [],
      activeConversationId: null,
      messages: [],
      pending: null,
      failures: {},
    });
  });

  it('records a failure and retries without a second user message', async () => {
    const conversation = mockRepo.createConversation('Pricing');
    const earlier = [
      mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'q1' }),
      mockRepo.appendMessage({ conversationId: conversation.id, role: 'assistant', text: 'a1' }),
    ];
    mockRun.mockRejectedValueOnce(new Error('The model is unavailable.'));
    mockRun.mockResolvedValueOnce(answer('retried answer'));

    const sent = useChatStore.getState().send('question', {
      conversationId: conversation.id,
      ...sendOptions,
    });
    await sent?.done;
    const conversationId = conversation.id;
    const userMessage = mockRepo.getMessages(conversationId)[2];

    expect(useChatStore.getState().failures[conversationId]).toEqual({
      conversationId,
      messageId: userMessage.id,
      question: 'question',
      reason: 'failed',
      message: 'Check your connection and try again.',
    });
    expect(useChatStore.getState().pending).toBeNull();

    await useChatStore.getState().retry(conversationId, { allowCloudFallback: true });

    expect(turnInput(0).history).toEqual(earlier);
    expect(turnInput(1)).toMatchObject({ question: 'question', allowCloudFallback: true });
    expect(turnInput(1).history).toEqual(earlier);
    expect(mockRepo.getMessages(conversationId).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'retried answer' },
    ]);
    expect(useChatStore.getState().failures).toEqual({});
  });

  it('falls back to a connection message when the error has none', async () => {
    mockRun.mockRejectedValueOnce(new Error(''));

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    await sent?.done;

    expect(useChatStore.getState().failures[sent?.conversationId ?? '']?.message).toBe(
      'Check your connection and try again.',
    );
  });

  it('keeps a failure through sends elsewhere and clears it on a send to its conversation', async () => {
    const other = mockRepo.createConversation('B');
    mockRun.mockRejectedValueOnce(new Error('boom'));
    mockRun.mockResolvedValue(answer('ok'));

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    await sent?.done;
    const failedId = sent?.conversationId ?? '';
    useChatStore.getState().openConversation(other.id);

    expect(Object.keys(useChatStore.getState().failures)).toEqual([failedId]);

    await useChatStore.getState().send('in B', { conversationId: other.id, ...sendOptions })?.done;
    await useChatStore.getState().send('a new chat', { conversationId: null, ...sendOptions })
      ?.done;

    expect(Object.keys(useChatStore.getState().failures)).toEqual([failedId]);

    const again = useChatStore.getState().send('again', {
      conversationId: failedId,
      ...sendOptions,
    });

    expect(useChatStore.getState().failures).toEqual({});
    await again?.done;
  });

  it('keeps each chat’s failure when another chat fails', async () => {
    const first = mockRepo.createConversation('A');
    const second = mockRepo.createConversation('B');
    mockRun.mockRejectedValueOnce(new Error('boom'));
    mockRun.mockRejectedValueOnce(new Error('boom'));
    mockRun.mockResolvedValueOnce(answer('retried A'));

    await useChatStore.getState().send('in A', { conversationId: first.id, ...sendOptions })?.done;
    await useChatStore.getState().send('in B', { conversationId: second.id, ...sendOptions })?.done;

    expect(Object.keys(useChatStore.getState().failures).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    await useChatStore.getState().retry(first.id, sendOptions);

    expect(turnInput(2).question).toBe('in A');
    expect(Object.keys(useChatStore.getState().failures)).toEqual([second.id]);
    expect(useChatStore.getState().editFailedQuestion(second.id)).toBe('in B');
    expect(useChatStore.getState().failures).toEqual({});
  });

  it('closes a conversation only while it is still the open one', () => {
    const first = mockRepo.createConversation('A');
    const second = mockRepo.createConversation('B');
    mockRepo.appendMessage({ conversationId: second.id, role: 'user', text: 'in B' });

    // Pushing B over A focuses B before A's blur closes A.
    useChatStore.getState().openConversation(first.id);
    useChatStore.getState().openConversation(second.id);
    useChatStore.getState().closeConversation(first.id);

    expect(useChatStore.getState().activeConversationId).toBe(second.id);
    expect(useChatStore.getState().messages.map(({ text }) => text)).toEqual(['in B']);

    useChatStore.getState().closeConversation(second.id);
    expect(useChatStore.getState()).toMatchObject({ activeConversationId: null, messages: [] });
  });

  it('hands the failed question back for editing and deletes it', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    const conversation = mockRepo.createConversation('A');
    useChatStore.getState().openConversation(conversation.id);

    const sent = useChatStore.getState().send('fix me', {
      conversationId: conversation.id,
      ...sendOptions,
    });
    await sent?.done;

    expect(useChatStore.getState().editFailedQuestion(conversation.id)).toBe('fix me');
    expect(mockRepo.getMessages(conversation.id)).toEqual([]);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().failures).toEqual({});
    expect(useChatStore.getState().editFailedQuestion(conversation.id)).toBeNull();
  });

  it('deletes a conversation that editing the failed question leaves empty', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));

    const sent = useChatStore.getState().send('fix me', {
      conversationId: null,
      ...sendOptions,
    });
    const conversationId = sent?.conversationId ?? '';
    useChatStore.getState().openConversation(conversationId);
    await sent?.done;

    expect(useChatStore.getState().editFailedQuestion(conversationId)).toBe('fix me');
    expect(mockRepo.getConversation(conversationId)).toBeNull();
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });

  it('keeps a conversation that still has messages after editing the failed question', async () => {
    const conversation = mockRepo.createConversation('A');
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'q1' });
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'assistant', text: 'a1' });
    mockRun.mockRejectedValueOnce(new Error('boom'));

    await useChatStore.getState().send('fix me', {
      conversationId: conversation.id,
      ...sendOptions,
    })?.done;

    expect(useChatStore.getState().editFailedQuestion(conversation.id)).toBe('fix me');
    expect(mockRepo.getConversation(conversation.id)).not.toBeNull();
    expect(mockRepo.getMessages(conversation.id).map(({ text }) => text)).toEqual(['q1', 'a1']);
  });

  it('cancel keeps the question, clears pending and records it as stopped', async () => {
    const turn = deferred<ChatTurnResult>();
    mockRun.mockReturnValueOnce(turn.promise);
    mockRun.mockResolvedValueOnce(answer('answered after all'));

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    const conversationId = sent?.conversationId ?? '';
    useChatStore.getState().cancel();

    expect(turnInput(0).signal.aborted).toBe(true);
    expect(useChatStore.getState().pending).toBeNull();

    turn.reject(abortError());
    await sent?.done;

    expect(mockRepo.getMessages(conversationId).map(({ text }) => text)).toEqual(['question']);
    expect(useChatStore.getState().failures[conversationId]).toMatchObject({
      question: 'question',
      reason: 'stopped',
    });
    expect(useChatStore.getState().pending).toBeNull();

    await useChatStore.getState().retry(conversationId, sendOptions);
    expect(turnInput(1).question).toBe('question');
    expect(mockRepo.getMessages(conversationId).map(({ text }) => text)).toEqual([
      'question',
      'answered after all',
    ]);
    expect(useChatStore.getState().failures).toEqual({});
  });

  it('records nothing when a spoken question is stopped before it is sent', () => {
    useChatStore.getState().beginTranscribing(null);
    useChatStore.getState().cancel();
    expect(useChatStore.getState().failures).toEqual({});
  });

  it('retries a saved question left without an answer, as after a relaunch', async () => {
    const conversation = mockRepo.createConversation('Pricing');
    const earlier = [
      mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'q1' }),
      mockRepo.appendMessage({ conversationId: conversation.id, role: 'assistant', text: 'a1' }),
    ];
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'cut off' });
    mockRun.mockResolvedValueOnce(answer('a2'));
    useChatStore.getState().openConversation(conversation.id);

    await useChatStore.getState().retry(conversation.id, sendOptions);

    expect(turnInput(0)).toMatchObject({ question: 'cut off', history: earlier });
    expect(mockRepo.getMessages(conversation.id).map(({ text }) => text)).toEqual([
      'q1',
      'a1',
      'cut off',
      'a2',
    ]);
  });

  it('does nothing on Retry when the last saved message is an answer', async () => {
    const conversation = mockRepo.createConversation('Pricing');
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'q1' });
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'assistant', text: 'a1' });

    await useChatStore.getState().retry(conversation.id, sendOptions);

    expect(mockRun).not.toHaveBeenCalled();
    expect(useChatStore.getState().editFailedQuestion(conversation.id)).toBeNull();
  });

  it('hands a saved unanswered question back for editing', () => {
    const conversation = mockRepo.createConversation('Pricing');
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'q1' });
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'assistant', text: 'a1' });
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'cut off' });
    useChatStore.getState().openConversation(conversation.id);

    expect(useChatStore.getState().editFailedQuestion(conversation.id)).toBe('cut off');
    expect(mockRepo.getMessages(conversation.id).map(({ text }) => text)).toEqual(['q1', 'a1']);
    expect(useChatStore.getState().messages.map(({ text }) => text)).toEqual(['q1', 'a1']);
  });

  it('never edits away a question that is still being answered', () => {
    mockRun.mockReturnValueOnce(deferred<ChatTurnResult>().promise);
    const sent = useChatStore.getState().send('working on it', {
      conversationId: null,
      ...sendOptions,
    });
    const conversationId = sent?.conversationId ?? '';

    expect(useChatStore.getState().editFailedQuestion(conversationId)).toBeNull();
    expect(mockRepo.getMessages(conversationId).map(({ text }) => text)).toEqual(['working on it']);
  });

  it('leaves unanswered questions out of the next turn’s history', async () => {
    const conversation = mockRepo.createConversation('Pricing');
    const say = (role: 'user' | 'assistant', text: string): void => {
      mockRepo.appendMessage({ conversationId: conversation.id, role, text });
    };
    say('user', 'q1');
    say('assistant', 'a1');
    say('user', 'stopped, then asked something else');
    say('user', 'q2');
    say('assistant', 'a2');
    say('user', 'failed');
    mockRun.mockResolvedValueOnce(answer('a3'));

    await useChatStore.getState().send('q3', { conversationId: conversation.id, ...sendOptions })
      ?.done;

    expect(turnInput(0).history.map(({ text }) => text)).toEqual(['q1', 'a1', 'q2', 'a2']);
    // The questions stay in the chat itself.
    expect(mockRepo.getMessages(conversation.id)).toHaveLength(8);
  });

  it('records a failure when a current turn rejects with an AbortError', async () => {
    mockRun.mockRejectedValueOnce(abortError());

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    await sent?.done;

    expect(useChatStore.getState().failures[sent?.conversationId ?? '']).toMatchObject({
      conversationId: sent?.conversationId,
      question: 'question',
      message: 'Check your connection and try again.',
    });
    expect(useChatStore.getState().pending).toBeNull();
  });

  it('ignores steps from a cancelled turn after a new one starts', () => {
    mockRun.mockReturnValue(deferred<ChatTurnResult>().promise);
    const turnTwoSteps = [
      { id: 'search' as const, status: 'active' as const, label: 'Searching…' },
    ];

    useChatStore.getState().send('first', { conversationId: null, ...sendOptions });
    useChatStore.getState().cancel();
    useChatStore.getState().send('second', { conversationId: null, ...sendOptions });
    turnInput(1).onSteps(turnTwoSteps);
    turnInput(0).onSteps([{ id: 'write', status: 'active', label: 'Writing your answer…' }]);

    expect(useChatStore.getState().pending?.steps).toEqual(turnTwoSteps);
  });

  it('ignores a late rejection after reset', async () => {
    const turn = deferred<ChatTurnResult>();
    mockRun.mockReturnValueOnce(turn.promise);

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    clearChatHistory();
    turn.reject(new Error('The model is unavailable.'));
    await sent?.done;

    expect(useChatStore.getState().failures).toEqual({});
    expect(useChatStore.getState().pending).toBeNull();
    expect(db.select().from(chatMessages).all()).toEqual([]);
  });

  it('refuses to send into a deleted conversation', () => {
    const conversation = mockRepo.createConversation('A');

    expect(useChatStore.getState().beginTranscribing(conversation.id)).toBe(true);
    useChatStore.getState().deleteConversation(conversation.id);
    const sent = useChatStore.getState().send('spoken', {
      conversationId: conversation.id,
      ...sendOptions,
    });

    expect(sent).toBeNull();
    expect(db.select().from(chatMessages).all()).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('holds one transcribing slot and refuses a send until it is released', async () => {
    mockRun.mockResolvedValueOnce(answer('ok'));

    expect(useChatStore.getState().beginTranscribing(null)).toBe(true);
    expect(useChatStore.getState().beginTranscribing(null)).toBe(false);
    expect(useChatStore.getState().pending).toMatchObject({
      conversationId: null,
      phase: 'transcribing',
    });
    expect(
      useChatStore.getState().send('typed', { conversationId: null, ...sendOptions }),
    ).toBeNull();
    expect(mockRepo.listConversations()).toEqual([]);

    useChatStore.getState().endTranscribing();
    const sent = useChatStore.getState().send('spoken', { conversationId: null, ...sendOptions });

    expect(sent).not.toBeNull();
    expect(useChatStore.getState().pending?.phase).toBe('working');
    useChatStore.getState().endTranscribing();
    expect(useChatStore.getState().pending?.phase).toBe('working');

    await sent?.done;
    useChatStore.getState().beginTranscribing(sent?.conversationId ?? null);
    useChatStore.getState().endTranscribing();
    expect(useChatStore.getState().pending).toBeNull();
  });

  it('deletes a conversation and cancels its running turn', async () => {
    const turn = deferred<ChatTurnResult>();
    mockRun.mockReturnValueOnce(turn.promise);

    const sent = useChatStore.getState().send('question', {
      conversationId: null,
      ...sendOptions,
    });
    const conversationId = sent?.conversationId ?? '';
    useChatStore.getState().openConversation(conversationId);
    useChatStore.getState().deleteConversation(conversationId);
    turn.resolve(answer('too late'));
    await sent?.done;

    expect(turnInput(0).signal.aborted).toBe(true);
    expect(db.select().from(chatMessages).all()).toEqual([]);
    expect(useChatStore.getState()).toMatchObject({
      conversations: [],
      activeConversationId: null,
      messages: [],
      pending: null,
    });
  });
});

describe('a failed chat wipe', () => {
  const WIPE_PENDING_KEY = '@openwhispr:chat_wipe_pending';
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    globalThis.localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
    } as Storage;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const seedPreviousAccount = (): string => {
    const conversation = mockRepo.createConversation('Previous account');
    mockRepo.appendMessage({ conversationId: conversation.id, role: 'user', text: 'secret' });
    return conversation.id;
  };

  const failClearAll = (times: number): void => {
    const clearAll = jest.spyOn(mockRepo, 'clearAll');
    for (let attempt = 0; attempt < times; attempt += 1) {
      clearAll.mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
    }
  };

  it('shows no saved chat until the wipe is finished, then finishes it before reading', () => {
    const previousId = seedPreviousAccount();
    failClearAll(3);

    expect(clearChatHistory()).toBe(false);
    useChatStore.getState().loadConversations();
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(
      useChatStore.getState().send('new question', { conversationId: null, ...sendOptions }),
    ).toBeNull();

    useChatStore.getState().openConversation(previousId);

    expect(useChatStore.getState().messages).toEqual([]);
    expect(mockRepo.getConversation(previousId)).toBeNull();
    expect(stored.has(WIPE_PENDING_KEY)).toBe(false);
  });

  it('says a send was refused by the wipe, until the wipe goes through', () => {
    seedPreviousAccount();
    failClearAll(3);
    expect(clearChatHistory()).toBe(false);
    expect(useChatStore.getState().sendBlocked).toBe(false);

    expect(
      useChatStore.getState().send('new question', { conversationId: null, ...sendOptions }),
    ).toBeNull();
    expect(useChatStore.getState().sendBlocked).toBe(true);

    // The third failed attempt; the next read finishes the wipe.
    useChatStore.getState().loadConversations();
    expect(useChatStore.getState().sendBlocked).toBe(true);
    useChatStore.getState().loadConversations();
    expect(useChatStore.getState().sendBlocked).toBe(false);
  });

  it('clears the refusal when a send gets through', () => {
    failClearAll(2);
    expect(clearChatHistory()).toBe(false);
    useChatStore.getState().send('first', { conversationId: null, ...sendOptions });
    expect(useChatStore.getState().sendBlocked).toBe(true);
    mockRun.mockReturnValueOnce(deferred<ChatTurnResult>().promise);

    expect(
      useChatStore.getState().send('again', { conversationId: null, ...sendOptions }),
    ).not.toBeNull();
    expect(useChatStore.getState().sendBlocked).toBe(false);
  });

  it('clears the refusal when a send is refused for another reason', () => {
    failClearAll(2);
    expect(clearChatHistory()).toBe(false);
    useChatStore.getState().send('first', { conversationId: null, ...sendOptions });
    expect(useChatStore.getState().sendBlocked).toBe(true);

    expect(useChatStore.getState().beginTranscribing(null)).toBe(true);
    expect(
      useChatStore.getState().send('again', { conversationId: null, ...sendOptions }),
    ).toBeNull();
    expect(useChatStore.getState().sendBlocked).toBe(false);
  });

  it('finishes the wipe on the next launch before any chat is read', () => {
    const previousId = seedPreviousAccount();
    failClearAll(1);
    expect(clearChatHistory()).toBe(false);
    expect(stored.has(WIPE_PENDING_KEY)).toBe(true);

    jest.isolateModules(() => {
      const relaunched = require('@/store/useChatStore') as typeof import('@/store/useChatStore');
      relaunched.useChatStore.getState().loadConversations();
      expect(relaunched.useChatStore.getState().conversations).toEqual([]);
    });

    expect(mockRepo.getConversation(previousId)).toBeNull();
    expect(stored.has(WIPE_PENDING_KEY)).toBe(false);
    // This module's own copy of the flag is still set; a read settles it.
    useChatStore.getState().loadConversations();
  });

  it('still wipes the saved chats when the store reset fails', () => {
    const previousId = seedPreviousAccount();
    const reset = useChatStore.getState().reset;
    useChatStore.setState({
      reset: () => {
        throw new Error('reset failed');
      },
    });

    expect(clearChatHistory()).toBe(false);

    useChatStore.setState({ reset });
    expect(mockRepo.getConversation(previousId)).toBeNull();
  });
});
