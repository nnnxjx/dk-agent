import { ChatService } from './chat.service';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';

jest.mock('../llm/llm.service', () => ({ LLMService: class {} }));

describe('ChatService incremental summary', () => {
  let service: ChatService;
  let conversation: Conversation;
  let messages: Message[];
  let invoke: jest.Mock;
  let update: jest.Mock;

  const history = (count: number) => Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 ? 'assistant' : 'user',
    content: `body-${i + 1};`,
  } as Message));

  beforeEach(() => {
    conversation = { id: 'conv', tenantId: 'tenant' } as Conversation;
    messages = history(21);
    invoke = jest.fn().mockResolvedValue({ content: 'summary-v1' });
    update = jest.fn().mockImplementation(async (_criteria, patch) => {
      Object.assign(conversation, patch);
      return { affected: 1 };
    });
    service = new ChatService(
      { findOne: jest.fn(async () => ({ ...conversation })), update } as any,
      {} as any,
      { del: jest.fn() } as any,
      { get: (key: string) => key === 'memory.windowSize' ? 10 : 20 } as any,
      { createModel: jest.fn(() => ({ invoke })) } as any,
    );
    jest.spyOn(service, 'getMessages').mockImplementation(async () => messages);
    jest.spyOn(service, 'getConversation').mockImplementation(async () => ({ ...conversation }));
  });

  it('summarizes the initial prefix and then only newly evicted messages', async () => {
    const first = await service.getContextMessages('conv', 'tenant');
    expect(conversation.summaryUntilMessageId).toBe('m11');
    expect(invoke.mock.calls[0][0][1].content).toContain('body-1;');
    expect(invoke.mock.calls[0][0][1].content).not.toContain('body-12;');
    expect(first).toEqual([
      { role: 'system', content: '[对话历史摘要]\nsummary-v1' },
      ...messages.slice(11).map(({ role, content }) => ({ role, content })),
    ]);

    messages = history(23);
    invoke.mockResolvedValue({ content: 'summary-v2' });
    await service.getContextMessages('conv', 'tenant');
    const prompt = invoke.mock.calls[1][0][1].content;
    expect(prompt).toContain('summary-v1');
    expect(prompt).toContain('body-12;');
    expect(prompt).toContain('body-13;');
    expect(prompt).not.toContain('body-11;');
    expect(prompt).not.toContain('body-14;');
    expect(conversation.summaryUntilMessageId).toBe('m13');

    await service.getContextMessages('conv', 'tenant');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'missing-id'])('rebuilds from originals when cursor is %s', async (cursor) => {
    conversation.summary = 'untrusted-old-summary';
    conversation.summaryUntilMessageId = cursor as any;
    await service.getContextMessages('conv', 'tenant');
    const prompt = invoke.mock.calls[0][0][1].content;
    expect(prompt).toContain('body-1;');
    expect(prompt).not.toContain('untrusted-old-summary');
    expect(conversation.summaryUntilMessageId).toBe('m11');
  });

  it.each(['failure', 'empty'])('keeps the previous summary and cursor after %s', async (mode) => {
    conversation.summary = 'old-summary';
    conversation.summaryUntilMessageId = 'm9';
    if (mode === 'failure') invoke.mockRejectedValue(new Error('unavailable'));
    else invoke.mockResolvedValue({ content: '   ' });
    const context = await service.getContextMessages('conv', 'tenant');
    expect(update).not.toHaveBeenCalled();
    expect(conversation.summaryUntilMessageId).toBe('m9');
    expect(context[0].content).toBe('[对话历史摘要]\nold-summary');
  });

  it('does not overwrite a summary whose cursor advanced during generation', async () => {
    conversation.summary = 'old-summary';
    conversation.summaryUntilMessageId = 'm9';
    update.mockResolvedValue({ affected: 0 });
    invoke.mockImplementation(async () => {
      conversation.summary = 'concurrent-summary';
      conversation.summaryUntilMessageId = 'm11';
      return { content: 'stale-summary' };
    });
    const context = await service.getContextMessages('conv', 'tenant');
    expect(update.mock.calls[0][0]).toMatchObject({
      id: 'conv', tenantId: 'tenant', summaryUntilMessageId: 'm9',
    });
    expect(context[0].content).toBe('[对话历史摘要]\nconcurrent-summary');
  });

  it('does not generate a summary before the threshold', async () => {
    messages = history(20);
    const context = await service.getContextMessages('conv', 'tenant');
    expect(context).toHaveLength(10);
    expect(invoke).not.toHaveBeenCalled();
  });
});
